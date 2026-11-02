import { useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTRPCClient } from '../trpc';
import { AccountFrame } from '../account/AccountParts';
import { accountNext, isVerificationDenied, needsConsent, needsEmailVerification } from '../account/access';
import { publicFailure } from '../auth/credentials';
import form from '../auth/AuthForm.module.css';
import {
  consentDocuments,
  documentKeys,
  documentTitles,
  readablePolicy,
  type ConsentDocument,
  type CurrentPolicy,
} from './model';
import styles from './Legal.module.css';

const route = getRouteApi('/legal/agree');
type View = { current: CurrentPolicy; required: ConsentDocument[] };

export function LegalAgreePage() {
  const { consentUserId: viewerId } = route.useRouteContext();
  const { next } = route.useSearch();
  const client = useTRPCClient(),
    queries = useQueryClient(),
    router = useRouter(),
    navigate = useNavigate();
  const destination = accountNext(next) ?? '/lobby';
  const generation = useRef(0),
    active = useRef<AbortController | null>(null),
    writing = useRef(false);
  const [view, setView] = useState<View | null>(null);
  const [checked, setChecked] = useState<Partial<Record<ConsentDocument, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true),
    [submitting, setSubmitting] = useState(false);

  const clear = useCallback(() => {
    generation.current++;
    active.current?.abort();
    active.current = null;
    setView(null);
    setChecked({});
    setError(null);
    setPending(false);
  }, []);

  const load = useCallback(async () => {
    clear();
    const own = generation.current,
      controller = new AbortController();
    active.current = controller;
    setPending(true);
    const results = await Promise.allSettled([
      client.auth.me.query(undefined, { signal: controller.signal }),
      client.account.get.query(undefined, { signal: controller.signal }),
      client.legal.current.query(undefined, { signal: controller.signal }),
    ]);
    if (own !== generation.current || controller.signal.aborted) return;
    active.current = null;
    setPending(false);
    const [identity, account, policy] = results;
    if (
      (identity.status === 'fulfilled' && identity.value.user?.id !== viewerId) ||
      results.some((result) => result.status === 'rejected' && publicFailure(result.reason)?.code === 'UNAUTHORIZED')
    ) {
      queries.clear();
      void router.invalidate();
      setError('계정이 바뀌었습니다. 현재 계정을 다시 확인합니다.');
      return;
    }
    if (identity.status === 'rejected' || account.status === 'rejected' || policy.status === 'rejected') {
      setError('계정과 현재 문서를 읽지 못했습니다. 다시 조회하세요.');
      return;
    }
    if (needsEmailVerification(account.value)) {
      void navigate({ to: '/verify-email', search: { next: destination }, replace: true });
      return;
    }
    setView({ current: policy.value, required: account.value.consentRequired });
    return own;
  }, [clear, client, destination, navigate, queries, router, viewerId]);

  useEffect(() => {
    void load();
    const focus = () => void load();
    const visibility = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('focus', focus);
    window.addEventListener('blur', clear);
    window.addEventListener('offline', clear);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', clear);
      window.removeEventListener('offline', clear);
      document.removeEventListener('visibilitychange', visibility);
      generation.current++;
      active.current?.abort();
    };
  }, [load, clear]);

  const policy = readablePolicy(view?.current);
  const optionalPending =
    view?.current.status === 'pending' && !view.current.signupRequiresPolicy && view.required.length === 0;
  const ready =
    view !== null &&
    (optionalPending || (policy !== null && view.required.every((doc) => checked[doc] === policy.stamp)));

  async function agree() {
    if (writing.current || !ready || !view) return;
    writing.current = true;
    setSubmitting(true);
    setError(null);
    const own = generation.current,
      controller = new AbortController(),
      stamp = policy?.stamp ?? null;
    active.current?.abort();
    active.current = controller;
    const options = { signal: controller.signal };
    const live = () => own === generation.current && !controller.signal.aborted;
    try {
      const identity = await client.auth.me.query(undefined, options);
      if (!live()) return;
      if (identity.user?.id !== viewerId) {
        queries.clear();
        void router.invalidate();
        throw new Error('identity');
      }
      const fresh = await client.legal.current.query(undefined, options);
      const account = await client.account.get.query(undefined, options);
      if (!live()) return;
      if (needsEmailVerification(account)) {
        await navigate({ to: '/verify-email', search: { next: destination }, replace: true });
        return;
      }
      if (
        (readablePolicy(fresh)?.stamp ?? null) !== stamp ||
        (stamp === null && !(fresh.status === 'pending' && !fresh.signupRequiresPolicy))
      )
        throw new Error('policy');
      for (const docType of consentDocuments) {
        if (!account.consentRequired.includes(docType)) continue;
        if (!policy || checked[docType] !== policy.stamp || !live()) throw new Error('selection');
        // 기대 ID는 마지막 me 뒤 다른 탭에서 계정이 바뀌어도 서버가 거부하는 조건이다.
        await client.legal.agree.mutate(
          { docType, version: policy[documentKeys[docType]].version, expectedUserId: viewerId },
          options,
        );
        if (!live()) return;
      }
      const afterIdentity = await client.auth.me.query(undefined, options);
      const afterAccount = await client.account.get.query(undefined, options);
      const afterPolicy = await client.legal.current.query(undefined, options);
      if (!live()) return;
      if (afterIdentity.user?.id !== viewerId) {
        queries.clear();
        void router.invalidate();
        throw new Error('identity');
      }
      if (needsEmailVerification(afterAccount)) {
        await navigate({ to: '/verify-email', search: { next: destination }, replace: true });
        return;
      }
      if (
        needsConsent(afterAccount) ||
        (readablePolicy(afterPolicy)?.stamp ?? null) !== stamp ||
        (stamp === null && !(afterPolicy.status === 'pending' && !afterPolicy.signupRequiresPolicy))
      )
        throw new Error('remaining');
      await navigate({ href: destination, replace: true });
    } catch (failure) {
      if (!live()) return;
      if (isVerificationDenied(failure)) {
        await navigate({ to: '/verify-email', search: { next: destination }, replace: true });
        return;
      }
      // 부분 성공은 보존한다. 서버가 아직 요구하는 문서를 다시 읽고 수동 조작을 기다린다.
      const loaded = await load();
      if (loaded !== undefined && loaded === generation.current)
        setError('완료한 동의는 기록에 남습니다. 현재 계정과 남은 문서를 확인한 뒤 다시 동의하세요.');
    } finally {
      writing.current = false;
      setSubmitting(false);
    }
  }

  return (
    <AccountFrame title="현재 문서 동의" plaque="새 판에 동의">
      {pending ? <p role="status">계정과 현재 문서를 확인하고 있습니다…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!pending && !view ? (
        <button type="button" className={form.submit} disabled={submitting} onClick={() => void load()}>
          다시 조회
        </button>
      ) : null}
      {view && !policy && !optionalPending ? (
        <p role="status">승인된 본문을 준비하고 있습니다. 동의는 준비 뒤 열립니다.</p>
      ) : null}
      {view && policy ? (
        <fieldset className={styles.consents} disabled={submitting}>
          <legend>다시 확인할 문서</legend>
          {view.required.length === 0 ? (
            <p>현재 판에 모두 동의했습니다.</p>
          ) : (
            view.required.map((docType) => {
              const document = policy[documentKeys[docType]];
              return (
                <div key={docType}>
                  <h2>{documentTitles[docType]}</h2>
                  <p>
                    판 {document.version} · 시행{' '}
                    <time dateTime={document.effectiveAt}>
                      {new Date(document.effectiveAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                    </time>
                  </p>
                  <div className={styles.body}>{document.bodyText}</div>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={checked[docType] === policy.stamp}
                      onChange={(event) => {
                        const accepted = event.target.checked;
                        setChecked((before) => ({ ...before, [docType]: accepted ? policy.stamp : '' }));
                      }}
                    />
                    <span>
                      {documentTitles[docType]} {document.version}에 동의합니다.
                    </span>
                  </label>
                </div>
              );
            })
          )}
        </fieldset>
      ) : null}
      {view ? (
        <button
          type="button"
          className={form.submit}
          disabled={!ready || submitting || pending}
          onClick={() => void agree()}
        >
          {submitting ? '확인 중…' : view.required.length > 0 ? '동의하고 계속하기' : '계속하기'}
        </button>
      ) : null}
      <p>
        <Link to="/account" className={styles.link}>
          내 계정과 동의 기록
        </Link>
      </p>
    </AccountFrame>
  );
}
