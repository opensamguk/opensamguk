// API 서버 주소. apps/server와 같은 우선순위를 쓴다:
// 프로세스 환경변수 > 루트 .env > 기본값 3001 (server의 --env-file은 이미 있는 환경변수를 덮어쓰지 않는다).
export const DEFAULT_SERVER_PORT = 3001;

export function resolveApiTarget(processEnv: Record<string, string | undefined>, fileEnv: Record<string, string>): string {
  const raw = processEnv.SERVER_PORT ?? fileEnv.SERVER_PORT;
  const port = raw === undefined || raw === '' ? DEFAULT_SERVER_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`SERVER_PORT가 올바른 포트가 아닙니다: "${raw}"`);
  }
  return `http://127.0.0.1:${port}`;
}
