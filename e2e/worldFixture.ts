import type { PrismaClient } from '../packages/db/src/index';
import type { WorldInit } from '../packages/rules/src/index';
import { saveInitialWorld, type InitialWorldOptions } from '../apps/engine/src/world/persistence';
import { processInputs } from '../apps/engine/src/inputs';

export { prepareInitialWorld, savePreparedInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';

// 로비는 월드의 시나리오 키를 게시 자원에서 읽어 제목을 붙이고, 하나라도 없으면 조회 전체가 500이다(apps/server/src/routers/lobby.ts).
// 합성 고정물의 시험 전용 키(예: engine-monthly-fixture)도 같은 DB의 로비를 깨지 않게, 없으면 제목만 담은 시나리오 자원을 게시한다.
// tools/int24-world-settings.integration.test.ts가 tools-int24-fixture를 게시하는 것과 같은 방식이다.
async function ensureFixtureScenario(db: PrismaClient, initial: WorldInit) {
  const { parseResourceKey } = await import('../packages/rules/src/index');
  const { hashState } = await import('../packages/shared/src/node/hashState');
  const ref = parseResourceKey(initial.scenarioKey);
  const found = await db.gameResource.findUnique({
    where: { kind_name_version: { kind: 'SCENARIO', ...ref } },
    select: { status: true },
  });
  if (found) return;
  const content = { id: ref.name, title: `시험 고정물 ${ref.name}`, startYear: initial.startYear };
  try {
    await db.gameResource.create({
      data: {
        kind: 'SCENARIO',
        ...ref,
        content,
        contentHash: hashState(content),
        status: 'PUBLISHED',
        publishedAt: new Date(),
        source: 'e2e 합성 고정물',
      },
    });
  } catch (error) {
    // 같은 DB의 다른 시험이 먼저 만들었으면 그대로 쓴다.
    if (!(error instanceof Error && 'code' in error && error.code === 'P2002')) throw error;
  }
}

// 생성 기록은 실제 관리자 생성과 같게 유지한다. 구형 crew는 부곡으로 암묵 변환하지 않는다.
export async function saveFixtureWorld(db: PrismaClient, source: WorldInit, options: InitialWorldOptions) {
  const initial = structuredClone(source);
  await ensureFixtureScenario(db, initial);
  const owners = initial.generals.filter((general) => general.userId !== null);
  initial.generals = initial.generals.map((general) => ({ ...general, userId: null, crew: 0 }));
  const saved = await saveInitialWorld(db, initial, options);
  try {
    await attachFixtureOwners(
      db,
      saved.worldId,
      owners.map(({ id, userId }) => ({ id, userId: userId! })),
    );
  } catch (error) {
    await db.world.delete({ where: { id: saved.worldId } });
    throw error;
  }
  return saved;
}

// 고정물 부착에서만 NPC 맡기를 허용한다. 입력·후속 인사 처리·revision을 엔진이 함께 기록한다.
export async function attachFixtureOwners(db: PrismaClient, worldId: string, owners: { id: number; userId: string }[]) {
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      if (!['PREOPEN', 'RUNNING'].includes(world.status)) throw Error('진행 가능한 고정물만 장수를 붙일 수 있습니다.');
      if (await tx.inputEvent.count({ where: { worldId, status: 'PENDING' } }))
        throw Error('고정물에 대기 입력이 있습니다.');
      for (const owner of owners) {
        const event = await tx.inputEvent.create({
          data: {
            worldId,
            userId: owner.userId,
            generalId: null,
            kind: 'general.possess',
            payload: { generalId: owner.id, userId: owner.userId },
            idempotencyKey: `fixture-possess:${owner.id}`,
            status: 'PENDING',
          },
        });
        const current = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        await processInputs(tx, { ...current, runtimeOptions: { entry: { npcPlay: 'on' } } }, current.clockTick);
        const applied = await tx.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
        if (applied.status !== 'APPLIED') throw Error(`고정물 NPC 맡기 실패: ${JSON.stringify(applied.result)}`);
      }
    },
    { timeout: 30_000 },
  );
}
