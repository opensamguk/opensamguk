import { TRPCClientError } from '@trpc/client';

// tRPC 오류 코드. 서버가 준 코드로만 화면 문구를 고른다.
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof TRPCClientError)) return undefined;
  const data: unknown = error.data;
  if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') return data.code;
  return undefined;
}

const CLIENT_ERRORS = new Set(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND']);

// 없는 월드·장수처럼 다시 물어도 같은 답이 오는 오류는 재시도하지 않는다.
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  const code = errorCode(error);
  return !(code !== undefined && CLIENT_ERRORS.has(code)) && failureCount < 1;
}

export const isNotFound = (error: unknown) => {
  const code = errorCode(error);
  return code === 'NOT_FOUND' || code === 'BAD_REQUEST';
};
