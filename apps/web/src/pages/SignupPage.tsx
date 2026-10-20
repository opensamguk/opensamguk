import { Link } from '@tanstack/react-router';
import { Placeholder } from './Placeholder';

export function SignupPage() {
  return (
    <main style={{ maxWidth: 360, margin: '64px auto' }}>
      <Placeholder title="가입" task="T1-14">
        <Link to="/login">로그인으로</Link>
      </Placeholder>
    </main>
  );
}
