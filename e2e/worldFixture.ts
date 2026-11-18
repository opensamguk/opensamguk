import type { PrismaClient } from '../packages/db/src/index';
import type { WorldInit } from '../packages/rules/src/index';
import { saveInitialWorld, type InitialWorldOptions } from '../apps/engine/src/world/persistence';
import { processInputs } from '../apps/engine/src/inputs';

export { prepareInitialWorld, savePreparedInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';

// 생성 기록은 실제 관리자 생성과 같게 유지한다. 구형 crew는 부곡으로 암묵 변환하지 않는다.
export async function saveFixtureWorld(db: PrismaClient, source: WorldInit, options: InitialWorldOptions) {
  const initial = structuredClone(source);
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
