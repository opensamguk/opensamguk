import type { APIRequestContext } from '@playwright/test';

// T1-16 E2E 도우미. 월드는 T1-15의 e2eWorld(e2e/game.ts)로 pnpm dev 엔진이 돌리는 첫 RUNNING 월드를 같이 쓴다 (실제 DB, 실제 엔진).
// 새로 만든 장수(general.create)는 재야라 국가 화면을 볼 수 없다. 국가 소속 화면을 보려고 시험 계정 하나만
// 시나리오의 소속 장수에 DB로 붙인다 (빙의에 해당하는 API는 아직 없다). 생성 API 경로는 main.spec.ts가 따로 시험한다.
// 그 밖의 모든 조회는 화면과 같은 HTTP 경로로 한다.

// 계정을 장수에 붙인다. 소속국이 있고 자기 국가 도시에 있는 장수 중 번호가 가장 작은 장수를 고른다.
// 엔진 TurnLoop와 같은 월드 행 잠금(FOR UPDATE)을 잡은 트랜잭션에서 바꾼다. 잠금 없이 바꾸면 엔진이 그 전에 읽어 둔
// 장수 행을 다시 쓰면서 userId를 null로 되돌릴 수 있다(엔진은 읽은 장수 행 전체를 다시 쓴다). GitHub #61에서 같은 SHA의
// home.get이 한 번은 404, 한 번은 통과한 원인을 이 경합으로 본다. 붙인 행이 하나가 아니면 바로 실패시킨다.
export async function bindGeneral(worldId: string, userId: string): Promise<void> {
  const { createDb } = await import('../packages/db/src/index');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL이 필요합니다.');
  const db = createDb(url);
  try {
    const count = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      return tx.$executeRaw`UPDATE "General" SET "userId" = ${userId}
WHERE "worldId" = ${worldId} AND "id" = (
  SELECT g."id" FROM "General" g
  JOIN "City" c ON c."worldId" = g."worldId" AND c."cityKey" = g."cityKey"
  WHERE g."worldId" = ${worldId} AND g."userId" IS NULL AND g."nationId" IS NOT NULL AND c."nationId" = g."nationId"
  ORDER BY g."id" LIMIT 1
)`;
    });
    if (count !== 1) throw new Error('붙일 소속 장수를 찾지 못했습니다');
  } finally {
    await db.$disconnect();
  }
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
