import { TRPCClientError } from '@trpc/client';

// tRPC 오류에서 서버가 정한 코드와 문구를 꺼낸다. 화면 판단은 이 코드로만 한다.
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const data: unknown = error.data;
  if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') return data.code;
  return undefined;
}

// 서버가 보낸 안내 문구. 응답을 못 받았으면(연결 실패 등) undefined다.
export function serverMessage(error: unknown): string | undefined {
  return errorCode(error) !== undefined && error instanceof Error && error.message ? error.message : undefined;
}

const CLIENT_ERRORS = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND']);

// 다시 물어도 같은 답이 오는 오류는 재시도하지 않는다.
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  const code = errorCode(error);
  return !(code !== undefined && CLIENT_ERRORS.has(code)) && failureCount < 1;
}
