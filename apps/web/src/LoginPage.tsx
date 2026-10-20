import { useEffect, useState } from 'react';
import { trpc } from './trpc';

type Status = { kind: 'checking' } | { kind: 'ok'; db: 'ok' | 'down' } | { kind: 'error' };

// 로그인 자리. 실제 가입·로그인은 AC-M1-05에서 연결한다.
export function LoginPage() {
  const [status, setStatus] = useState<Status>({ kind: 'checking' });

  useEffect(() => {
    trpc.health
      .query()
      .then((res) => setStatus({ kind: 'ok', db: res.db }))
      .catch(() => setStatus({ kind: 'error' }));
  }, []);

  return (
    <main style={{ maxWidth: 360, margin: '64px auto', fontFamily: 'system-ui, sans-serif' }}>
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
      <p role="status">{statusText(status)}</p>
    </main>
  );
}

function statusText(status: Status): string {
  switch (status.kind) {
    case 'checking':
      return '서버 확인 중…';
    case 'error':
      return '서버에 연결할 수 없습니다';
    case 'ok':
      return status.db === 'ok' ? '서버 정상 · DB 정상' : '서버 정상 · DB 연결 안 됨';
  }
}
