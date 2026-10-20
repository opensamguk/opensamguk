import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { AuthForm } from '../auth/AuthForm';
import styles from '../auth/AuthPage.module.css';
import { useTRPC } from '../trpc';

const route = getRouteApi('/login');

export function LoginPage() {
  const { next } = route.useSearch();
  const trpc = useTRPC();
  const health = useQuery(trpc.health.queryOptions());

  return (
    <main className={styles.page}>
      <h1>로그인</h1>
      <AuthForm mode="login" next={next} />
      <p className={styles.switch}>
        계정이 없으면 <Link to="/signup" search={next ? { next } : {}}>가입하기</Link>
      </p>
      <p role="status" className={styles.status}>
        {statusText(health)}
      </p>
    </main>
  );
}

function statusText(health: { isPending: boolean; isError: boolean; data: { db: 'ok' | 'down' } | undefined }): string {
  if (health.isPending) return '서버 확인 중…';
  if (health.isError || !health.data) return '서버에 연결할 수 없습니다';
  return health.data.db === 'ok' ? '서버 정상 · DB 정상' : '서버 정상 · DB 연결 안 됨';
}
