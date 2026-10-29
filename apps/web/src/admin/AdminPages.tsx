import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@opensamguk/server/router';
import { Link, Outlet, useRouteContext, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTRPCClient } from '../trpc';
import { publicFailure } from '../auth/credentials';
import { ErrorState, LoadingState } from '../ui/States';
import { auditFilter, searchFilter, type AuditFilter } from './filters';
import { usePrivateRead } from './usePrivateRead';
import { AdminUserDetail } from './AdminUserDetail';
import { AdminSanctionActions } from './AdminSanctionActions';
import { AdminInvestigation, AdminReadIdentityError, readCurrentAdminData } from './AdminInvestigation';
import styles from './AdminPages.module.css';

type Outputs = inferRouterOutputs<AppRouter>['admin'];
// Prisma JSON의 재귀 타입을 JSX 전체로 전개하지 않는다. payload는 텍스트로만 표시한다.
type AuditPage = {
  items: Array<{
    id: string;
    at: string;
    actorKind: string;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    worldId: string | null;
    reason: string | null;
    inputEventId: string | null;
    payload: unknown;
  }>;
  next: string | null;
};
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });
function Time({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {date.format(new Date(value))}
    </time>
  );
}
function useViewer() {
  return useRouteContext({ from: '/admin' }).adminViewerId;
}

export function AdminLayout() {
  const viewerId = useViewer(),
    client = useTRPCClient(),
    router = useRouter(),
    checkGeneration = useRef(0);
  const [checking, setChecking] = useState(false),
    [checkError, setCheckError] = useState(false);
  const retryCheck = useRef<() => void>(() => {});
  useEffect(() => {
    let mounted = true;
    setChecking(false);
    setCheckError(false);
    const check = () => {
      const own = ++checkGeneration.current;
      setChecking(true);
      setCheckError(false);
      void Promise.allSettled([client.auth.me.query(), client.admin.whoami.query()]).then((results) => {
        if (!mounted || own !== checkGeneration.current) return;
        const identity = results[0];
        const denied = results.some(
          (result) =>
            result.status === 'rejected' &&
            ['UNAUTHORIZED', 'FORBIDDEN'].includes(publicFailure(result.reason)?.code ?? ''),
        );
        if (denied || (identity.status === 'fulfilled' && identity.value.user?.id !== viewerId)) {
          void router.invalidate();
          return;
        }
        if (results.some((result) => result.status === 'rejected')) {
          setCheckError(true);
          return;
        }
        setChecking(false);
      });
    };
    retryCheck.current = check;
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    const visible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted = false;
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [router, client, viewerId]);
  return (
    <main className={styles.shell}>
      <header>
        <h1>관리자 콘솔</h1>
        <Link to="/lobby">로비</Link>
      </header>
      <nav aria-label="관리자 메뉴">
        <Link to="/admin" preload={false}>
          안내
        </Link>
        <Link to="/admin/worlds" preload={false}>
          월드 목록
        </Link>
        <Link to="/admin/users" preload={false}>
          사용자 찾기
        </Link>
        <Link to="/admin/audit" preload={false}>
          감사 기록
        </Link>
        <Link to="/admin/notices" preload={false}>
          공지 관리
        </Link>
      </nav>
      <p>조회 결과에는 개인정보가 포함됩니다. 필요한 범위만 확인하세요.</p>
      {checkError ? (
        <ErrorState
          title="접근 권한을 확인하지 못했습니다. 작성 내용은 이 탭에 보존했습니다."
          onRetry={() => retryCheck.current()}
        />
      ) : checking ? (
        <LoadingState>접근 권한 확인 중</LoadingState>
      ) : null}
      <section key={viewerId} hidden={checking} inert={checking}>
        <Outlet />
      </section>
    </main>
  );
}

export function AdminHome() {
  return (
    <section>
      <h2>운영 조회</h2>
      <p>월드·사용자·감사 기록을 조회하고 로비·월드 공지를 관리합니다.</p>
      <p>
        사용자 상세에서 참가 장수·제재 이력을 확인하고 제재를 등록·해제합니다. 월드 조작과 로그인 자료 화면은 준비
        중입니다.
      </p>
    </section>
  );
}

export function AdminUsers() {
  const viewerId = useViewer(),
    client = useTRPCClient(),
    router = useRouter();
  const searchForm = useRef<HTMLFormElement>(null);
  const query = usePrivateRead<Outputs['user']['search']>(viewerId);
  const detail = usePrivateRead<Outputs['user']['get']>(viewerId);
  const [detailId, setDetailId] = useState(''),
    [detailError, setDetailError] = useState<string | null>(null),
    [actionLocked, setActionLocked] = useState(false);
  function readDetail(value: string, afterAction = false) {
    if (actionLocked && !afterAction) return;
    detail.clear();
    setDetailError(null);
    const userId = value.trim();
    setDetailId(userId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      setDetailError('사용자 UUID를 확인하세요.');
      return;
    }
    void detail.read(async (signal) => {
      try {
        return await readCurrentAdminData(
          viewerId,
          {
            me: (next) => client.auth.me.query(undefined, { signal: next }),
            whoami: (next) => client.admin.whoami.query(undefined, { signal: next }),
          },
          signal,
          (next) => client.admin.user.get.query({ userId }, { signal: next }),
        );
      } catch (failure) {
        if (failure instanceof AdminReadIdentityError) void router.invalidate();
        throw failure;
      }
    });
  }
  const [kind, setKind] = useState('account'),
    [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionLocked) return;
    query.clear();
    detail.clear();
    setError(null);
    try {
      const input = searchFilter(new FormData(event.currentTarget));
      void query.read((signal) => client.admin.user.search.query(input, { signal }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력을 확인하세요.');
    }
  }
  return (
    <section>
      <h2>사용자 찾기</h2>
      <form
        ref={searchForm}
        className={styles.form}
        onSubmit={submit}
        onChange={() => {
          if (actionLocked) return;
          query.clear();
          detail.clear();
          setDetailError(null);
          setError(null);
        }}
      >
        <label>
          검색 방식
          <select name="kind" value={kind} disabled={actionLocked} onChange={(e) => setKind(e.target.value)}>
            <option value="account">이메일 앞부분·사용자 UUID</option>
            <option value="general">월드·장수 이름</option>
          </select>
        </label>
        {kind === 'general' ? (
          <>
            <label>
              월드 UUID
              <input name="worldId" required maxLength={36} disabled={actionLocked} />
            </label>
            <label>
              장수 이름 앞부분
              <input name="generalName" required maxLength={30} disabled={actionLocked} />
            </label>
          </>
        ) : (
          <label>
            이메일 앞부분 또는 사용자 UUID
            <input name="query" required minLength={3} maxLength={254} autoComplete="off" disabled={actionLocked} />
          </label>
        )}
        <button type="submit" disabled={query.pending || actionLocked}>
          찾기
        </button>
      </form>
      <p>찾기 버튼을 누를 때만 조회하고 감사 기록을 남깁니다. 최대50명을 표시합니다.</p>
      {error || query.error ? <ErrorState title={error ?? query.error!} /> : null}
      {query.pending ? <LoadingState /> : null}
      {query.data ? (
        <>
          <p role="status">{query.data.length}명</p>
          <table className={styles.table}>
            <caption>사용자 검색 결과</caption>
            <thead>
              <tr>
                <th scope="col">사용자</th>
                <th scope="col">상태·역할</th>
                <th scope="col">가입 시각</th>
                <th scope="col">유효 제재</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((user) => (
                <tr key={user.userId}>
                  <td>
                    {user.email}
                    <br />
                    <code>{user.userId}</code>
                    <br />
                    <button
                      type="button"
                      disabled={actionLocked}
                      onClick={() => readDetail(user.userId)}
                      aria-label={`${user.email} 상세 보기`}
                    >
                      상세 보기
                    </button>
                  </td>
                  <td>
                    {user.status} · {user.role}
                  </td>
                  <td>
                    <Time value={user.createdAt} />
                  </td>
                  <td>{user.activeSanctions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <AdminUserDetail
        userId={detailId}
        disabled={actionLocked}
        onChange={(value) => {
          if (actionLocked) return;
          setDetailId(value);
          detail.clear();
          setDetailError(null);
        }}
        onRead={readDetail}
        data={detail.data}
        pending={detail.pending}
        error={detailError ?? detail.error}
      />
      <AdminSanctionActions
        key={viewerId}
        viewerId={viewerId}
        target={detail.data}
        onRead={(value) => readDetail(value, true)}
        onClear={() => {
          detail.clear();
          query.clear();
          searchForm.current?.reset();
          setDetailId('');
          setDetailError(null);
          setError(null);
        }}
        onLockChange={setActionLocked}
      />
      <AdminInvestigation
        key={`investigation:${viewerId}`}
        viewerId={viewerId}
        disabled={actionLocked}
        source={{
          me: (signal) => client.auth.me.query(undefined, { signal }),
          whoami: (signal) => client.admin.whoami.query(undefined, { signal }),
          worlds: (signal) => client.admin.world.list.query(undefined, { signal }),
          shared: (input, signal) => client.admin.investigate.shared.query(input, { signal }),
        }}
        onAccessDenied={() => {
          void router.invalidate();
        }}
      />
    </section>
  );
}

export function AdminAudit() {
  const viewerId = useViewer(),
    client = useTRPCClient();
  const query = usePrivateRead<AuditPage>(viewerId);
  const [filter, setFilter] = useState<AuditFilter | null>(null),
    [error, setError] = useState<string | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    query.clear();
    setFilter(null);
    setError(null);
    try {
      const input = auditFilter(new FormData(event.currentTarget));
      setFilter(input);
      void query.read((signal) => client.admin.audit.list.query(input, { signal }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력을 확인하세요.');
    }
  }
  const next = query.data?.next;
  return (
    <section>
      <h2>감사 기록</h2>
      <form
        className={styles.form}
        onSubmit={submit}
        onChange={() => {
          query.clear();
          setFilter(null);
          setError(null);
        }}
      >
        <label>
          시작 시각 (한국)
          <input type="datetime-local" name="from" />
        </label>
        <label>
          끝 시각 (한국)
          <input type="datetime-local" name="to" />
        </label>
        <label>
          행위 종류 앞부분
          <input name="action" maxLength={100} placeholder="user.search" />
        </label>
        <label>
          행위자 UUID
          <input name="actorUserId" maxLength={36} />
        </label>
        <label>
          대상
          <input name="targetId" maxLength={200} />
        </label>
        <label>
          월드 UUID
          <input name="worldId" maxLength={36} />
        </label>
        <button type="submit" disabled={query.pending}>
          조회
        </button>
      </form>
      <p>최신 ID부터50건씩 표시합니다. 다음 페이지는 현재 필터를 유지합니다.</p>
      {error || query.error ? <ErrorState title={error ?? query.error!} /> : null}
      {query.pending ? <LoadingState /> : null}
      {query.data ? (
        <>
          <p role="status">{query.data.items.length}건</p>
          <table className={styles.table}>
            <caption>감사 조회 결과</caption>
            <thead>
              <tr>
                <th scope="col">ID·시각</th>
                <th scope="col">행위</th>
                <th scope="col">행위자·대상·월드</th>
                <th scope="col">사유·기록</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {item.id}
                    <br />
                    <Time value={item.at} />
                  </td>
                  <td>
                    {item.action}
                    <br />
                    {item.actorKind}
                  </td>
                  <td>
                    <dl>
                      <dt>행위자</dt>
                      <dd>{item.actorUserId ?? '없음'}</dd>
                      <dt>대상</dt>
                      <dd>
                        {item.targetType} · {item.targetId ?? '없음'}
                      </dd>
                      <dt>월드</dt>
                      <dd>{item.worldId ?? '없음'}</dd>
                      <dt>입력</dt>
                      <dd>{item.inputEventId ?? '없음'}</dd>
                    </dl>
                  </td>
                  <td>
                    {item.reason ?? '사유 없음'}
                    <pre>{JSON.stringify(item.payload, null, 2)}</pre>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {next && filter ? (
            <button
              type="button"
              onClick={() =>
                void query.read((signal) => client.admin.audit.list.query({ ...filter, cursor: next }, { signal }))
              }
            >
              다음50건
            </button>
          ) : (
            <p>마지막 페이지입니다.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
