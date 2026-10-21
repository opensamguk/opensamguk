import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { APIRequestContext } from '@playwright/test';

// T1-16 E2E용 실제 월드. 엔진 CLI로 시나리오 월드를 만들고 시작한다 (실제 DB, 실제 엔진).
// 새로 만든 장수(general.create)는 재야라 국가 화면을 볼 수 없다. 국가 소속 화면을 보려고 시험 계정 하나만
// 시나리오의 소속 장수에 DB로 붙인다 (빙의에 해당하는 API는 아직 없다). 생성 API 경로는 main.spec.ts가 따로 시험한다.
// 그 밖의 모든 조회는 화면과 같은 HTTP 경로로 한다.
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

export async function createRunningWorld(name: string, turnTermMinutes = 1): Promise<string> {
  const created = await run(
    'pnpm',
    [
      '-s',
      'world:create',
      '--scenario',
      '1030',
      '--map',
      'che',
      '--seed',
      name,
      '--turn-term',
      String(turnTermMinutes),
      '--name',
      name,
    ],
    { env: process.env, maxBuffer: 1 << 20 },
  );
  const worldId = lastJson(created.stdout).worldId;
  if (typeof worldId !== 'string' || !UUID.test(worldId)) throw new Error('월드 생성 결과에 worldId가 없습니다');
  await run('pnpm', ['-s', 'world:start', '--world', worldId], { env: process.env });
  return worldId;
}

// 계정을 장수에 붙인다. 소속국이 있고 자기 국가 도시에 있는 장수 중 번호가 가장 작은 장수를 고른다.
export async function bindGeneral(worldId: string, userId: string): Promise<void> {
  if (!UUID.test(worldId) || !UUID.test(userId)) throw new Error('UUID가 아닙니다');
  const sql = `UPDATE "General" SET "userId" = '${userId}'
WHERE "worldId" = '${worldId}' AND "id" = (
  SELECT g."id" FROM "General" g
  JOIN "City" c ON c."worldId" = g."worldId" AND c."cityKey" = g."cityKey"
  WHERE g."worldId" = '${worldId}' AND g."userId" IS NULL AND g."nationId" IS NOT NULL AND c."nationId" = g."nationId"
  ORDER BY g."id" LIMIT 1
);`;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'pnpm',
      ['--filter', '@opensamguk/db', 'exec', 'prisma', 'db', 'execute', '--stdin'],
      { env: process.env },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.end(sql);
  });
}

// tRPC GET 조회. 화면과 같은 /trpc 경로와 같은 쿠키를 쓴다.
export async function query<T>(request: APIRequestContext, path: string, input?: unknown): Promise<T> {
  const url =
    input === undefined ? `/trpc/${path}` : `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const response = await request.get(url);
  if (!response.ok()) throw new Error(`${path} HTTP ${response.status()}`);
  const body = (await response.json()) as { result: { data: T } };
  return body.result.data;
}
