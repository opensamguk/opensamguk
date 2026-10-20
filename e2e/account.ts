import type { Page } from '@playwright/test';

// E2E 전용 테스트 계정. 실행마다 새 이메일을 써서 로컬 DB에 남은 계정과 부딪히지 않게 한다.
export const TEST_PASSWORD = 'e2e-password-0001';

export function newEmail(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

// 화면을 거치지 않고 API로 가입한다. page.request는 브라우저와 쿠키를 같이 쓰므로 로그인 상태가 된다.
export async function signUpByApi(page: Page, email = newEmail()): Promise<string> {
  const response = await page.request.post('/trpc/auth.signup', { data: { email, password: TEST_PASSWORD } });
  if (!response.ok()) throw new Error(`가입 실패: HTTP ${response.status()}`);
  return email;
}
