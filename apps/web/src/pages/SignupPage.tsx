import { getRouteApi, Link } from '@tanstack/react-router';
import { AuthForm } from '../auth/AuthForm';
import styles from '../auth/AuthPage.module.css';

const route = getRouteApi('/signup');

// 이메일 인증·약관 동의는 M3 (T3-03).
export function SignupPage() {
  const { next } = route.useSearch();
  return (
    <main className={styles.page}>
      <h1>가입</h1>
      <AuthForm mode="signup" next={next} />
      <p className={styles.switch}>
        이미 계정이 있으면{' '}
        <Link to="/login" search={next ? { next } : {}}>
          로그인
        </Link>
      </p>
    </main>
  );
}
