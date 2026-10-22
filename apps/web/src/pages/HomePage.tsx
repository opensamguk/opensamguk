import { LogoutButton } from '../auth/LogoutButton';
import { EmptyState } from '../ui/States';

// 로그인했지만 돌아갈 주소(next)가 없을 때 오는 곳. 열린 월드가 있으면 라우터가 첫 RUNNING 월드로 보낸다 (T1-16).
// 여기까지 왔다면 진행 중인 월드가 없다.
export function HomePage() {
  return (
    <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
      <h1>참가할 월드</h1>
      <EmptyState title="열린 월드가 없습니다">진행 중인 월드가 생기면 이 주소에서 바로 들어갑니다.</EmptyState>
      <p>
        <LogoutButton />
      </p>
    </main>
  );
}
