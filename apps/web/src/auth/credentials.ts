import { TRPCClientError } from '@trpc/client';

// 화면 쪽 입력 검사. 서버(apps/server/src/routers/auth.ts)와 같은 범위를 쓰되 최종 판단은 서버 응답이다.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const EMAIL_MAX = 254;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface FieldErrors {
  email?: string;
  password?: string;
}

export function validateCredentials(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  const trimmed = email.trim();
  if (trimmed === '') errors.email = '이메일을 입력하세요';
  else if (trimmed.length > EMAIL_MAX || !EMAIL_SHAPE.test(trimmed)) errors.email = '이메일 형식이 맞지 않습니다';
  if (password === '') errors.password = '비밀번호를 입력하세요';
  else if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    errors.password = `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자입니다`;
  }
  return errors;
}

// 서버가 답한 실패는 문구로, 답을 못 받은 실패(네트워크·서버 오류)는 다시 시도로 보여 준다.
export type SubmitFailure = { kind: 'message'; text: string } | { kind: 'retry' };

export function describeFailure(error: unknown): SubmitFailure {
  const code = error instanceof TRPCClientError ? (error.data as { code?: string } | undefined)?.code : undefined;
  if (code === 'UNAUTHORIZED') return { kind: 'message', text: '이메일 또는 비밀번호가 맞지 않습니다' };
  if (code === 'CONFLICT') return { kind: 'message', text: '이미 가입된 이메일입니다' };
  if (code === 'BAD_REQUEST') return { kind: 'message', text: '입력값을 확인하세요' };
  return { kind: 'retry' };
}

// 로그인 뒤 돌아갈 주소. 같은 사이트 안의 경로만 받는다 (열린 리다이렉트 방지).
// 브라우저는 주소 속 탭·줄바꿈을 지우므로 "/\t/evil" 같은 값이 "//evil"이 되지 않게 공백도 막는다.
export function safeNext(next: unknown): string | null {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return null;
  if (next.includes('\\') || /\s/.test(next)) return null;
  const path = next.split(/[?#]/, 1)[0];
  if (path === '/login' || path === '/signup') return null;
  return next;
}
