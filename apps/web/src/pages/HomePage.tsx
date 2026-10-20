import { LogoutButton } from '../auth/LogoutButton';
import { Placeholder } from './Placeholder';

// 로그인했지만 돌아갈 주소(next)가 없을 때 오는 곳.
// 첫 RUNNING 월드로 보내려면 월드 목록 API가 필요하다 (T1-20 Codex → 화면 연결은 T1-16).
export function HomePage() {
   return (
    <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
      <Placeholder title="참가할 월드" task="T1-20">
        월드 주소(/w/…)로 직접 들어가세요.
      </Placeholder>
      <p>
        <LogoutButton />
      </p>
    </main>
  );
}
