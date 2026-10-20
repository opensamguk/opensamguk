import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTRPC } from '../trpc';

// 로그인 자리. 실제 가입·로그인은 T1-14에서 연결한다 (API는 T1-10).
export function LoginPage() {
  const trpc = useTRPC();
  const health = useQuery(trpc.health.queryOptions());

  return (
    <main style={{ maxWidth: 360, margin: '64px auto' }}>
      <h1>로그인</h1>
      <form onSubmit={(e) => e.preventDefault()}>
        <p>
          <label>
            이메일
            <br />
            <input type="email" name="email" autoComplete="email" />
          </label>
        </p>
        <p>
          <label>
            비밀번호
            <br />
            <input type="password" name="password" autoComplete="current-password" />
          </label>
        </p>
        <button type="submit" disabled>
          로그인 (준비 중)
        </button>
      </form>
      <p>
        <Link to="/signup">가입하기</Link>
      </p>
      <p role="status">{statusText(health)}</p>
    </main>
  );
}

function statusText(health: { isPending: boolean; isError: boolean; data: { db: 'ok' | 'down' } | undefined }): string {
  if (health.isPending) return '서버 확인 중…';
  if (health.isError || !health.data) return '서버에 연결할 수 없습니다';
  return health.data.db === 'ok' ? '서버 정상 · DB 정상' : '서버 정상 · DB 연결 안 됨';
}
