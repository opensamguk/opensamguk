import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useRouter } from '@tanstack/react-router';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTRPCClient } from '../trpc';
import { publicFailure, retryAfterSeconds } from '../auth/credentials';
import { AccountFrame } from './AccountParts';
import { VerificationRequest } from './VerifyEmailPage';
import { WithdrawalActions } from './WithdrawalActions';
import { privacyStamp } from './withdrawalPolicy';
import styles from './Account.module.css';

type Outputs = inferRouterOutputs<AppRouter>;
type Snapshot = { account: Outputs['account']['get']; policy: Outputs['legal']['current'] };
type Phase = 'loading' | 'ready' | 'refresh' | 'sending' | 'ambiguous' | 'done';
class IdentityChanged extends Error {}

export function AccountPage({ viewerId }: { viewerId: string }) {
  const client = useTRPCClient(),
    queries = useQueryClient(),
    router = useRouter();
  const [view, setView] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const generation = useRef(0),
    active = useRef<AbortController | null>(null),
    writing = useRef(false);
  const terminal = useRef<'ambiguous' | 'done' | null>(null);
  const live = (own: number, controller: AbortController) => own === generation.current && !controller.signal.aborted;
  const clearPrivate = useCallback(() => {
    generation.current++;
    active.current?.abort();
    active.current = null;
    setView(null);
  }, []);
  const clearQueries = useCallback(async () => {
    await queries.cancelQueries();
    queries.clear();
  }, [queries]);
  const identityChanged = useCallback(() => {
    clearPrivate();
    void clearQueries();
    setMessage('계정이 바뀌었습니다. 현재 계정을 다시 확인합니다.');
    setPhase('refresh');
    void router.invalidate();
  }, [clearPrivate, clearQueries, router]);
  const snapshot = useCallback(
    async (signal: AbortSignal): Promise<Snapshot> => {
      const first = await client.auth.me.query(undefined, { signal });
      if (first.user?.id !== viewerId) throw new IdentityChanged();
      const account = await client.account.get.query(undefined, { signal });
      if (account.userId !== viewerId) throw new IdentityChanged();
      const policy = await client.legal.current.query(undefined, { signal });
      const last = await client.auth.me.query(undefined, { signal });
      if (last.user?.id !== viewerId) throw new IdentityChanged();
      return { account, policy };
    },
    [client, viewerId],
  );
  const load = useCallback(async () => {
    if (writing.current || terminal.current !== null || (retryAt !== null && Date.now() < retryAt)) return;
    clearPrivate();
    setPhase('loading');
    setMessage(null);
    setRetryAt(null);
    const own = generation.current,
      controller = new AbortController();
    active.current = controller;
    try {
      const value = await snapshot(controller.signal);
      if (!live(own, controller)) return;
      setView(value);
      setPhase('ready');
    } catch (error) {
      if (!live(own, controller)) return;
      if (error instanceof IdentityChanged || publicFailure(error)?.code === 'UNAUTHORIZED') identityChanged();
      else {
        setMessage('계정과 현재 문서를 읽지 못했습니다. 다시 조회하세요.');
        setPhase('refresh');
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [clearPrivate, identityChanged, retryAt, snapshot]);
  // 조회 자료와 비밀번호는 탭을 떠날 때 지운다. 전송 결과가 불명인 요청은 다시 접수하지 않는다.
  useLayoutEffect(() => {
    void load();
    const invalidate = () => {
      clearPrivate();
      if (writing.current) {
        terminal.current = 'ambiguous';
        setPhase('ambiguous');
        setMessage('탈퇴 처리 결과를 확인할 수 없습니다. 다시 접수하지 말고 로그인 상태를 확인하세요.');
      } else if (terminal.current !== 'done') setPhase(terminal.current ?? 'refresh');
    };
    const focus = () => {
      if (terminal.current !== 'done') {
        invalidate();
        return;
      }
      clearPrivate();
      const own = generation.current,
        controller = new AbortController();
      active.current = controller;
      void client.auth.me.query(undefined, { signal: controller.signal }).then(
        (identity) => {
          if (!live(own, controller)) return;
          if (identity.user) {
            terminal.current = null;
            identityChanged();
          }
        },
        () => {
          if (!live(own, controller)) return;
          terminal.current = 'ambiguous';
          setPhase('ambiguous');
          setMessage('현재 로그인 상태를 확인하지 못했습니다. 로그인 화면에서 확인하세요.');
        },
      );
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') invalidate();
    };
    window.addEventListener('blur', invalidate);
    window.addEventListener('focus', focus);
    window.addEventListener('offline', invalidate);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', invalidate);
      window.removeEventListener('focus', focus);
      window.removeEventListener('offline', invalidate);
      document.removeEventListener('visibilitychange', visibility);
      generation.current++;
      active.current?.abort();
    };
    // retryAt만 바뀌었을 때 요청을 자동 반복하지 않는다.
  }, [viewerId]);
  useLayoutEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  useBlocker({
    disabled: !sending,
    enableBeforeUnload: sending,
    shouldBlockFn: () => {
      setMessage('탈퇴 요청의 응답을 기다리고 있습니다.');
      return true;
    },
  });

  async function withdraw(password: string, stamp: string) {
    if (writing.current || phase !== 'ready' || !view || privacyStamp(view.policy) !== stamp) return;
    writing.current = true;
    setSending(true);
    setPhase('sending');
    setMessage(null);
    setView(null);
    const own = generation.current,
      controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    let sent = false;
    const deadline = setTimeout(() => {
      if (own === generation.current) {
        if (sent) {
          terminal.current = 'ambiguous';
          setPhase('ambiguous');
          setMessage('탈퇴 처리 결과를 확인할 수 없습니다. 다시 접수하지 말고 로그인 상태를 확인하세요.');
        } else {
          setPhase('refresh');
          setMessage('현재 정보를 확인하지 못해 탈퇴를 접수하지 않았습니다. 다시 조회하세요.');
        }
      }
      controller.abort();
    }, 30_000);
    try {
      const fresh = await snapshot(controller.signal);
      if (!live(own, controller)) return;
      if (!fresh.account.withdrawalAvailable || privacyStamp(fresh.policy) !== stamp) {
        setPhase('refresh');
        setMessage('처리 기준이 바뀌었습니다. 현재 문서를 다시 확인하세요.');
        return;
      }
      await clearQueries();
      if (!live(own, controller)) return;
      sent = true;
      // 직접 client를 호출한다. 비밀번호를 QueryClient의 MutationCache에 넣지 않는다.
      const result = await client.account.withdraw.mutate(
        { expectedUserId: viewerId, password },
        { signal: controller.signal },
      );
      if (!live(own, controller)) return;
      await clearQueries();
      if (!live(own, controller)) return;
      if (!result.ok) throw new Error('unconfirmed');
      const after = await client.auth.me.query(undefined, { signal: controller.signal });
      if (!live(own, controller)) return;
      if (after.user !== null) {
        if (after.user.id !== viewerId) identityChanged();
        else throw new Error('unconfirmed');
        return;
      }
      terminal.current = 'done';
      setPhase('done');
      setMessage(null);
    } catch (error) {
      if (!live(own, controller)) return;
      if (!sent && (error instanceof IdentityChanged || publicFailure(error)?.code === 'UNAUTHORIZED')) {
        identityChanged();
        return;
      }
      if (!sent) {
        setPhase('refresh');
        setMessage('현재 정보를 확인하지 못해 탈퇴를 접수하지 않았습니다. 다시 조회하세요.');
        return;
      }
      const code = publicFailure(error)?.code;
      if (code === 'BAD_REQUEST' || code === 'TOO_MANY_REQUESTS') {
        const seconds = code === 'TOO_MANY_REQUESTS' ? retryAfterSeconds(error) : null;
        // 대기 시간을 모르는429는 재전송 가능하다고 추측하지 않는다.
        if (code === 'TOO_MANY_REQUESTS' && seconds === null) {
          terminal.current = 'ambiguous';
          setPhase('ambiguous');
          setMessage('대기 시간을 확인하지 못했습니다. 로그인 화면에서 확인하세요.');
          return;
        }
        setRetryAt(seconds === null ? null : Date.now() + seconds * 1000);
        setNow(Date.now());
        setPhase('refresh');
        setMessage(
          code === 'TOO_MANY_REQUESTS'
            ? '요청이 이어져 잠시 기다려야 합니다. 대기 후 현재 정보를 다시 확인하세요.'
            : '입력과 처리 기준을 확인하세요. 현재 정보를 다시 확인할 수 있습니다.',
        );
      } else {
        terminal.current = 'ambiguous';
        setPhase('ambiguous');
        setMessage('탈퇴 처리 결과를 확인할 수 없습니다. 다시 접수하지 말고 로그인 상태를 확인하세요.');
      }
    } finally {
      clearTimeout(deadline);
      writing.current = false;
      setSending(false);
      if (active.current === controller) active.current = null;
    }
  }
  const remaining = retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <AccountFrame title={phase === 'done' ? '탈퇴 완료' : '내 계정'} panels>
      {/* 첩 세 장 (INT-20 A-Account): 내 정보 · 동의 기록 · 계정 탈퇴. 상태 문장은 맨 위 첩에 모은다. */}
      {message || phase !== 'ready' ? (
        <section className={`${styles.panel} ${styles.wide}`}>
          {message ? <p role="alert">{message}</p> : null}
          {phase === 'loading' ? <p role="status">계정과 현재 문서를 확인하고 있습니다…</p> : null}
          {phase === 'sending' ? <p role="status">탈퇴 요청의 응답을 기다리고 있습니다…</p> : null}
          {phase === 'done' ? <p role="status">탈퇴 처리와 로그인 종료를 확인했습니다.</p> : null}
          {phase === 'ambiguous' ? (
            <p>
              <Link to="/forgot-password">비밀번호 재설정</Link>
            </p>
          ) : null}
          {phase === 'refresh' ? (
            <button
              className={`${styles.touch} ${styles.button}`}
              type="button"
              disabled={sending || remaining > 0}
              onClick={() => void load()}
            >
              {remaining > 0 ? `${remaining}초 뒤 현재 정보 다시 확인` : '현재 정보 다시 확인'}
            </button>
          ) : null}
        </section>
      ) : null}
      {phase === 'ready' && view ? (
        <>
          <section className={styles.panel}>
            <span className={styles.plaque}>내 정보</span>
            <dl className={styles.facts}>
              <dt>이메일</dt>
              <dd>{view.account.email}</dd>
              <dt>인증</dt>
              <dd>{view.account.emailVerified ? '확인됨' : '확인 필요'}</dd>
            </dl>
            {!view.account.emailVerified ? <VerificationRequest email={view.account.email} /> : null}
            <nav aria-label="계정 설정" className={styles.links}>
              <Link to="/legal/terms">이용약관</Link>
              <Link to="/legal/privacy">개인정보처리방침</Link>
              <Link to="/forgot-password">비밀번호 재설정</Link>
              <Link to="/settings/notifications">알림 설정</Link>
            </nav>
          </section>
          <section className={styles.panel}>
            <h2>동의 기록</h2>
            {view.account.consentRequired.length > 0 ? (
              <p>
                <Link to="/legal/agree" search={{ next: '/account' }}>
                  현재 문서를 확인하고 동의하기
                </Link>
              </p>
            ) : null}
            {view.account.consents.length === 0 ? (
              <p>기록된 동의가 없습니다.</p>
            ) : (
              <ul className={styles.consents}>
                {view.account.consents.map((consent) => (
                  <li key={consent.docType + ':' + consent.version}>
                    {consent.docType === 'TERMS' ? '이용약관' : '개인정보처리방침'} {consent.version} ·{' '}
                    <time dateTime={consent.agreedAt}>{new Date(consent.agreedAt).toLocaleDateString('ko-KR')}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={`${styles.panel} ${styles.dangerPanel}`}>
            <h2>계정 탈퇴</h2>
            {view.account.withdrawalAvailable && privacyStamp(view.policy) !== null ? (
              <WithdrawalActions stamp={privacyStamp(view.policy)!} onWithdraw={withdraw} />
            ) : (
              <p role="status">
                탈퇴 처리 기준을 준비하고 있습니다. <Link to="/legal/privacy">개인정보처리방침 확인</Link>
              </p>
            )}
          </section>
        </>
      ) : null}
    </AccountFrame>
  );
}
