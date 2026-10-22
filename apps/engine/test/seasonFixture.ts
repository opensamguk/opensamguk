// 짧은 종료 시험용이다. 1030 완주 데모나 AC-M1-17 증거로 쓰지 않는다.
import { nextActionSequence, type PrismaClient, type Prisma } from '@opensamguk/db';
import { emptyTurns, type WorldInit } from '@opensamguk/rules';
import { monthlyFixture } from './monthlyFixture';
import { warFixture } from './warFixture';
import { saveInitialWorld } from '../src/world/persistence';
import { controlClock } from '../src/world/clock';
import { acquireLease, releaseLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';

export async function seasonInitial(reason: 'END_YEAR' | 'UNIFIED'): Promise<WorldInit> {
  if (reason === 'END_YEAR') {
    const initial = await monthlyFixture();
    initial.generals = [];
    return initial;
  }
  const initial = await warFixture();
  initial.cities = initial.cities.slice(0, 2).map((city) => ({
    ...city,
    connections: [city.cityKey === 1 ? 2 : 1],
    wall: 0,
    defence: 0,
  }));
  initial.generals = initial.generals.slice(0, 1);
  delete initial.nationTurns;
  return initial;
}

export async function recordTestTurns(
  db: PrismaClient,
  worldId: string,
  generalId: number,
  commandKey: string,
  args: Prisma.InputJsonValue = {},
) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    const general = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: generalId } } });
    const turns = emptyTurns();
    turns[0] = { commandKey, args };
    await tx.generalTurn.deleteMany({ where: { worldId, generalId } });
    await tx.generalTurn.createMany({
      data: turns.map((turn, slot) => ({
        ...turn,
        worldId,
        generalId,
        slot,
        args: turn.args as Prisma.InputJsonValue,
      })),
    });
    await tx.general.update({
      where: { worldId_id: { worldId, id: generalId } },
      data: { turnRevision: { increment: 1 } },
    });
    const sequence = await nextActionSequence(tx, worldId);
    await tx.inputEvent.create({
      data: {
        worldId,
        userId: general.userId ?? 'season-fixture',
        generalId,
        sequence,
        kind: 'turns.set',
        idempotencyKey: `fixture-${sequence}`,
        status: 'APPLIED',
        payload: { turns, revision: general.turnRevision } as unknown as Prisma.InputJsonValue,
        result: { revision: general.turnRevision + 1 },
      },
    });
  });
}

// 호출자가 두 계정으로 REALTIME/ACCELERATED를 관측한 뒤 runEngine을 시작할 수 있다.
export async function prepareSeasonWorld(
  db: PrismaClient,
  reason: 'END_YEAR' | 'UNIFIED',
  options: { beforeStart?: (worldId: string) => Promise<void> } = {},
) {
  const initial = await seasonInitial(reason);
  const { worldId } = await saveInitialWorld(db, initial, {
    name: `종료 시험 ${reason}`,
    turnTermMinutes: 60,
    endYear: initial.startYear,
  });
  if (reason === 'UNIFIED') await recordTestTurns(db, worldId, 1, 'attack', { cityKey: 2 });
  await options.beforeStart?.(worldId);
  await controlClock(db, worldId, 'start');
  return { worldId, initial };
}

export async function finishSeasonWorld(db: PrismaClient, worldId: string) {
  await controlClock(db, worldId, 'accelerate');
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 월드 실행권이 없습니다.');
  try {
    const loop = new TurnLoop(db, lease);
    for (;;) {
      const batch = await loop.poll();
      if (batch.status === 'ENDED' && !batch.more) break;
    }
    return await db.worldResult.findUniqueOrThrow({ where: { worldId } });
  } finally {
    await releaseLease(db, lease);
  }
}
