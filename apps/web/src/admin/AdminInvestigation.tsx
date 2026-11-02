import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { publicFailure } from '../auth/credentials';
import { ErrorState, LoadingState } from '../ui/States';
import styles from './AdminPages.module.css';

export type InvestigationWorld = { id: string; name: string; status: string };
export type InvestigationGroup = {
  kind: 'IP' | 'DEVICE';
  label: string;
  users: Array<{ userId: string; generalId: number; generalName: string; logins: number; lastAt: string }>;
};
export type InvestigationSource = {
  me(signal: AbortSignal): Promise<{ user: { id: string } | null }>;
  whoami(signal: AbortSignal): Promise<{ admin: true }>;
  worlds(signal: AbortSignal): Promise<InvestigationWorld[]>;
  shared(input: { worldId: string; days: number }, signal: AbortSignal): Promise<InvestigationGroup[]>;
};
export class AdminReadIdentityError extends Error {
  constructor() {
    super('현재 계정과 관리자 권한을 다시 확인하세요.');
  }
}

// 자료 조회와 신원 확인을 같은 실제 HTTP query batch에서 시작한다.
export async function readCurrentAdminData<T>(
  viewerId: string,
  source: Pick<InvestigationSource, 'me' | 'whoami'>,
  signal: AbortSignal,
  query: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const [identity, admin, value] = await Promise.all([source.me(signal), source.whoami(signal), query(signal)]);
  signal.throwIfAborted();
  if (identity.user?.id !== viewerId || admin.admin !== true) throw new AdminReadIdentityError();
  const [after, permission] = await Promise.all([source.me(signal), source.whoami(signal)]);
  signal.throwIfAborted();
  if (after.user?.id !== viewerId || permission.admin !== true) throw new AdminReadIdentityError();
  return value;
}
type State = {
  viewerId: string;
  worlds: InvestigationWorld[] | null;
  worldId: string;
  days: string;
  confirmed: boolean;
  groups: InvestigationGroup[] | null;
  pending: 'worlds' | 'shared' | null;
  error: string | null;
};
const initial = (viewerId: string): State => ({
  viewerId,
  worlds: null,
  worldId: '',
  days: '7',
  confirmed: false,
  groups: null,
  pending: null,
  error: null,
});
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });

// A full hash or raw address in an unexpected backend label must never reach the DOM.
export function maskedInvestigationGroups(groups: InvestigationGroup[]): InvestigationGroup[] {
  return groups.map((group) => {
    if (!['IP', 'DEVICE'].includes(group.kind) || !/^[0-9a-f]{8}$/.test(group.label) || group.users.length < 2)
      throw new Error('조사 자료 형식을 확인하지 못했습니다.');
    if (new Set(group.users.map((user) => user.userId)).size !== group.users.length)
      throw new Error('조사 자료 형식을 확인하지 못했습니다.');
    return {
      kind: group.kind,
      label: group.label,
      users: group.users.map((user) => {
        if (
          !uuid.test(user.userId) ||
          !Number.isSafeInteger(user.generalId) ||
          user.generalId < 1 ||
          typeof user.generalName !== 'string' ||
          user.generalName.length > 30 ||
          !Number.isSafeInteger(user.logins) ||
          user.logins < 1 ||
          !Number.isFinite(Date.parse(user.lastAt))
        )
          throw new Error('조사 자료 형식을 확인하지 못했습니다.');
        return {
          userId: user.userId,
          generalId: user.generalId,
          generalName: user.generalName,
          logins: user.logins,
          lastAt: user.lastAt,
        };
      }),
    };
  });
}

// The adapter invokes each .query synchronously so identity and data share one actual HTTP batch.
// The API remains responsible for current admin permission and the same-transaction audit.
export function AdminInvestigation({
  viewerId,
  source,
  onAccessDenied,
  disabled = false,
}: {
  viewerId: string;
  source: InvestigationSource;
  onAccessDenied: () => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<State>(() => initial(viewerId));
  const sourceRef = useRef(source),
    deniedRef = useRef(onAccessDenied),
    viewerRef = useRef(viewerId);
  sourceRef.current = source;
  deniedRef.current = onAccessDenied;
  viewerRef.current = viewerId;
  const generation = useRef(0),
    active = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const cancel = useCallback(() => {
    generation.current++;
    active.current?.abort();
    active.current = null;
  }, []);
  const clear = useCallback(() => {
    cancel();
    setState(initial(viewerRef.current));
  }, [cancel]);
  useEffect(() => {
    mounted.current = true;
    clear();
    for (const event of ['focus', 'blur', 'online', 'offline']) window.addEventListener(event, clear);
    document.addEventListener('visibilitychange', clear);
    return () => {
      mounted.current = false;
      cancel();
      for (const event of ['focus', 'blur', 'online', 'offline']) window.removeEventListener(event, clear);
      document.removeEventListener('visibilitychange', clear);
    };
  }, [viewerId, clear, cancel]);
  useEffect(() => {
    if (disabled) clear();
  }, [disabled, clear]);
  const current = state.viewerId === viewerId ? state : initial(viewerId);
  const edit = (patch: Partial<State>) => {
    cancel();
    setState({ ...current, ...patch, groups: null, pending: null, error: null });
  };

  async function read<T>(
    kind: 'worlds' | 'shared',
    query: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => Partial<State>,
  ) {
    if (disabled || current.pending) return;
    cancel();
    const own = generation.current,
      actor = viewerId,
      controller = new AbortController();
    active.current = controller;
    setState({ ...(kind === 'worlds' ? initial(actor) : current), groups: null, pending: kind, error: null });
    const fresh = () =>
      mounted.current && !controller.signal.aborted && generation.current === own && viewerRef.current === actor;
    try {
      const value = await readCurrentAdminData(actor, sourceRef.current, controller.signal, query);
      if (!fresh()) return;
      const patch = apply(value);
      setState((previous) => ({ ...previous, ...patch, pending: null, error: null }));
    } catch (failure) {
      if (!fresh()) return;
      const code = publicFailure(failure)?.code;
      if (failure instanceof AdminReadIdentityError || code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        clear();
        deniedRef.current();
      } else
        setState((previous) => ({
          ...previous,
          groups: null,
          pending: null,
          error: '조회하지 못했습니다. 조건과 권한을 확인한 뒤 다시 조회하세요.',
        }));
    } finally {
      if (generation.current === own && active.current === controller) active.current = null;
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || current.pending) return;
    const days = Number(current.days);
    if (
      !uuid.test(current.worldId) ||
      !current.worlds?.some((world) => world.id === current.worldId) ||
      !/^[1-9]\d?$/.test(current.days) ||
      days > 90 ||
      !current.confirmed
    ) {
      cancel();
      setState({ ...current, groups: null, error: '조회한 월드와 1~90일의 기간을 고르고 확인란을 선택하세요.' });
      return;
    }
    void read(
      'shared',
      (signal) => sourceRef.current.shared({ worldId: current.worldId, days }, signal),
      (groups) => ({ groups: maskedInvestigationGroups(groups) }),
    );
  }
  return (
    <section className={styles.investigation} aria-label="다중계정 조사">
      <h3>다중계정 조사</h3>
      <p>
        같은 월드 참가자가 공유한 IP·기기 기록을 조사 자료로 확인합니다. 공유 기록만으로 부정 플레이를 확정할 수
        없습니다.
      </p>
      <p>
        필요한 범위만 조회하세요. 조회할 때마다 관리자 감사 기록을 남깁니다. 기간은 조회 조건이며 공개 보존 정책의
        승인이나 자동 삭제를 뜻하지 않습니다.
      </p>
      <button
        type="button"
        disabled={disabled || Boolean(current.pending)}
        onClick={() => {
          void read(
            'worlds',
            (signal) => sourceRef.current.worlds(signal),
            (worlds) => ({ worlds }),
          );
        }}
      >
        조사할 월드 목록 조회
      </button>
      <form className={styles.form} noValidate onSubmit={submit}>
        <label>
          조사할 월드
          <select
            value={current.worldId}
            disabled={disabled || Boolean(current.pending) || !current.worlds}
            onChange={(event) => edit({ worldId: event.target.value, confirmed: false })}
          >
            <option value="">월드를 고르세요</option>
            {current.worlds?.map((world) => (
              <option key={world.id} value={world.id}>
                {world.name} · {world.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          조회 기간 (일)
          <input
            type="number"
            min="1"
            max="90"
            step="1"
            value={current.days}
            disabled={disabled || Boolean(current.pending)}
            onChange={(event) => edit({ days: event.target.value, confirmed: false })}
          />
        </label>
        <label className={styles.investigationConfirm}>
          <input
            type="checkbox"
            checked={current.confirmed}
            disabled={disabled || Boolean(current.pending)}
            onChange={(event) => edit({ confirmed: event.target.checked })}
          />
          필요한 월드와 기간의 개인정보만 확인합니다.
        </label>
        <button type="submit" disabled={disabled || Boolean(current.pending) || !current.worldId || !current.confirmed}>
          공유 기록 조회
        </button>
      </form>
      {current.pending ? (
        <>
          <LoadingState>조사 자료 조회 중</LoadingState>
          <button type="button" onClick={clear}>
            조회 취소
          </button>
        </>
      ) : null}
      {current.error ? <ErrorState title={current.error} /> : null}
      {current.worlds?.length === 0 ? <p>조회할 월드가 없습니다.</p> : null}
      {current.groups ? (
        <>
          <p role="status">공유 묶음 {current.groups.length}개</p>
          {current.groups.length === 0 ? <p>선택한 월드와 기간에 두 계정 이상이 공유한 기록이 없습니다.</p> : null}
          <div className={styles.investigationGroups}>
            {current.groups.map((group, index) => (
              <article key={`${group.kind}:${index}`}>
                <h4>
                  {group.kind === 'IP' ? 'IP' : '기기'} 공유 묶음 {index + 1}
                </h4>
                <p>
                  가림 이름 <code>{group.label}</code>
                </p>
                <ul>
                  {group.users.map((user) => (
                    <li key={user.userId}>
                      <p>
                        {user.generalName} · 장수 {user.generalId}
                      </p>
                      <p>
                        사용자 <code>{user.userId}</code>
                      </p>
                      <p>
                        기록 횟수 {user.logins}회 · 최근{' '}
                        <time dateTime={user.lastAt} title={user.lastAt}>
                          {time.format(new Date(user.lastAt))}
                        </time>
                      </p>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
