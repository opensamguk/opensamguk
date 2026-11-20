import { ZodError } from 'zod';

// 원본 메시지·입력·SQL·연결 문자열 대신 오류 종류와 코드 위치만 남긴다.
export function errorDiagnostic(error: unknown, depth = 0): object {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const code =
    'code' in error && typeof error.code === 'string' && /^(P\d{4}|E[A-Z_]+)$/.test(error.code)
      ? error.code
      : undefined;
  const locations = [...(error.stack ?? '').replaceAll('\\', '/').matchAll(/(?:apps|packages)\/[\w./-]+:\d+:\d+/g)]
    .slice(0, 5)
    .map(([location]) => location);
  return {
    name: error instanceof ZodError ? 'ZodError' : error.constructor.name.replace(/[^A-Za-z]/g, '').slice(0, 64),
    ...(code ? { code } : {}),
    locations,
    ...(error instanceof ZodError
      ? {
          issues: error.issues.slice(0, 10).map((issue) => ({
            code: issue.code,
            path: issue.path.map((part) => (typeof part === 'number' ? part : '[field]')),
            ...('expected' in issue ? { expected: issue.expected } : {}),
          })),
        }
      : {}),
    ...(depth < 3 && error.cause !== undefined ? { cause: errorDiagnostic(error.cause, depth + 1) } : {}),
  };
}
