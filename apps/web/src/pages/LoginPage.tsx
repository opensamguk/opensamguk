import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { AuthForm } from '../auth/AuthForm';
import styles from '../auth/AuthPage.module.css';
import { PublicMapTabs } from '../publicMap/PublicMapTabs';
import { useTRPC } from '../trpc';

const route = getRouteApi('/login');

export function LoginPage() {
  const { next } = route.useSearch();
  const trpc = useTRPC();
  const health = useQuery(trpc.health.queryOptions());

  // 양식이 먼저다. 넓은 화면에서는 오른쪽, 640px 이하에서는 양식 아래에 공개 지도를 둔다 (T2-25).
  return (
    <main className={styles.withMap}>
      <div className={styles.formColumn}>
        <h1>로그인</h1>
        <AuthForm mode="login" next={next} />
        <p className={styles.switch}>
          계정이 없으면{' '}
          <Link to="/signup" search={next ? { next } : {}}>
            가입하기
          </Link>
        </p>
        <p role="status" className={styles.status}>
          {statusText(health)}
        </p>
      </div>
      <PublicMapTabs />
    </main>
  );
}

function statusText(health: { isPending: boolean; isError: boolean; data: { db: 'ok' | 'down' } | undefined }): string {
  if (health.isPending) return '서버 확인 중…';
  if (health.isError || !health.data) return '서버에 연결할 수 없습니다';
  return health.data.db === 'ok' ? '서버 정상 · DB 정상' : '서버 정상 · DB 연결 안 됨';
}
