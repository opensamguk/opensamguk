import { randomUUID } from 'node:crypto';
import { nextActionSequence, type Prisma, type PrismaClient } from '@opensamguk/db';
import { applyNationTurnsRecord, type WorldInit } from '@opensamguk/rules';
import { saveInitialWorld, type InitialWorldOptions } from '../src/world/persistence';
import { processInputs } from '../src/inputs';
import { loadReplayState } from '../src/monthly';
import { loadOfficeState, persistOfficeState } from '../src/personnelState';

export async function attachFixtureOwners(db: PrismaClient, worldId: string, owners: { id: number; userId: string }[]) {
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      for (const owner of owners) {
        const event = await tx.inputEvent.create({
          data: {
            worldId,
            userId: owner.userId,
            kind: 'general.possess',
            idempotencyKey: `fixture-possess:${owner.id}`,
            payload: { generalId: owner.id, userId: owner.userId },
          },
        });
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        await processInputs(tx, { ...world, runtimeOptions: { entry: { npcPlay: 'on' } } }, world.clockTick);
        const applied = await tx.inputEvent.findUniqueOrThrow({ where: { id: event.id } });
        if (applied.status !== 'APPLIED') throw Error(`고정물 NPC 맡기 실패: ${JSON.stringify(applied.result)}`);
      }
    },
    { timeout: 30_000 },
  );
}

export async function recordFixtureNationTurns(
  db: PrismaClient,
  worldId: string,
  turns: NonNullable<WorldInit['nationTurns']>,
) {
  for (const [nationId, slots] of Object.entries(turns)) {
    const ruler = await db.general.findFirstOrThrow({
      where: { worldId, nationId: Number(nationId), officerLevel: 12 },
    });
    if (ruler.userId === null) throw Error('직책 고정물은 먼저 사람 군주를 준비해야 합니다.');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      const before = await loadReplayState(tx, worldId);
      const office = before.offices?.[Number(nationId)]?.[12] ?? { revision: 0, tenure: 0 };
      const input = {
        sequence: await nextActionSequence(tx, worldId),
        generalId: ruler.id,
        kind: 'nationTurns.set' as const,
        status: 'APPLIED' as const,
        payload: {
          office: { nationId: Number(nationId), officerLevel: 12, tenure: office.tenure },
          revision: office.revision,
          turns: slots.slice(0, 12),
        },
        result: { revision: office.revision + 1 },
      };
      const next = applyNationTurnsRecord(before.state, before.offices ?? {}, input);
      await persistOfficeState(tx, worldId, await loadOfficeState(tx, worldId), {
        ...next.state,
        offices: next.offices,
      });
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      const event = await tx.inputEvent.create({
        data: {
          ...input,
          worldId,
          userId: ruler.userId!,
          payload: input.payload as unknown as Prisma.InputJsonValue,
          tick: world.clockTick,
          idempotencyKey: `nationTurns.set:${randomUUID()}`,
          result: { ...input.result, activeTick: world.clockTick },
        },
      });
      await tx.general.update({
        where: { worldId_id: { worldId, id: ruler.id } },
        data: {
          lastActiveTick: Math.max(ruler.lastActiveTick ?? 0, world.clockTick),
          lastActiveAt: event.createdAt,
        },
      });
    });
  }
}

export async function saveFixtureWorld(db: PrismaClient, source: WorldInit, options: InitialWorldOptions) {
  const initial = structuredClone(source);
  const nationTurns = initial.nationTurns;
  delete initial.nationTurns;
  const owners = initial.generals
    .filter((general) => general.userId !== null)
    .map(({ id, userId }) => ({ id, userId: userId! }));
  if (initial.generals.some((general) => general.crew !== 0))
    throw Error('개인 병력은 생성 고정물에 넣을 수 없습니다.');
  initial.generals.forEach((general) => {
    general.userId = null;
  });
  const saved = await saveInitialWorld(db, initial, options);
  try {
    await attachFixtureOwners(db, saved.worldId, owners);
  } catch (error) {
    await db.world.delete({ where: { id: saved.worldId } });
    throw error;
  }
  if (nationTurns) await recordFixtureNationTurns(db, saved.worldId, nationTurns);
  return saved;
}
