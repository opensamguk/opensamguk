import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { emptyQueue, type WorldInit } from '@opensamguk/rules';
import { saveFixtureWorld, recordFixtureNationTurns } from './worldFixture';
import { controlClock } from '../src/world/clock';
import { acquireLease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';
import { recordTestTurns } from './seasonFixture';

export const BATTLE_PREPARATION_TICK = 100_000;
export type FixtureArmy = { generalId: number; troops: number; crewType: number };
export const warArmies: FixtureArmy[] = [
  { generalId: 1, troops: 10_000, crewType: 1100 },
  { generalId: 2, troops: 20, crewType: 1100 },
  { generalId: 3, troops: 10, crewType: 1100 },
];

// AC-M1-14 / AC-INT-28: 병력은 실제 모집·훈련·사기 예턴으로 준비하며 생성 원본에는 넣지 않는다.
export async function prepareBattleFixture(db: PrismaClient, source: WorldInit, armies = warArmies) {
  const initial = structuredClone(source);
  for (const city of initial.cities) {
    city.commerce = city.commerceMax = 2_000_000;
    city.agriculture = city.agricultureMax = 2_000_000;
  }
  for (const army of armies) {
    const general = initial.generals.find(({ id }) => id === army.generalId)!;
    // 준비 9개월의 실제 모집비·봉급·군량을 감당할 전투 시험 자원이다.
    general.gold = 10_000_000;
    general.rice = 10_000_000;
  }
  const users: string[] = [];
  for (const general of initial.generals) {
    if (general.crew !== 0) throw Error('전투 고정물은 개인 병력 없이 시작해야 합니다.');
    if (general.userId === null) {
      const id = randomUUID();
      await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'test-only' } });
      general.userId = id;
      users.push(id);
    }
  }
  const nationTurns = initial.nationTurns;
  delete initial.nationTurns;
  const { worldId } = await saveFixtureWorld(db, initial, {
    name: '실제 모집 전투 고정물',
    turnTermMinutes: 60,
    endYear: null,
  });
  await controlClock(db, worldId, 'start');
  const lease = (await acquireLease(db, worldId, undefined, 120_000))!;
  const loop = new TurnLoop(db, lease);
  // 첫 세수로 도시 금을 마련한 뒤 실제 물류 매입을 거쳐 모집한다.
  await loop.advanceTo(10_000);
  const cities = new Set(armies.map((army) => initial.generals.find(({ id }) => id === army.generalId)!.cityKey));
  for (const cityKey of cities) {
    const owner = initial.cities.find((city) => city.cityKey === cityKey)!.nationId;
    const ruler = initial.generals.find((general) => general.nationId === owner && general.officerLevel === 12)!;
    await db.inputEvent.create({
      data: {
        worldId,
        userId: ruler.userId!,
        generalId: ruler.id,
        kind: 'logistics.order',
        idempotencyKey: `battle-iron-${cityKey}`,
        payload: { type: 'trade', cityKey, good: 'iron', side: 'buy', amount: 1000 },
      },
    });
  }
  await loop.advanceTo(10_000);
  for (const army of armies) {
    const turns = emptyQueue();
    turns[0] = {
      commandKey: 'recruit',
      args: { amount: army.troops, crewType: army.crewType, unitId: 'new' },
      explicit: true,
    };
    for (let slot = 1; slot <= 8; slot++)
      turns[slot] = { commandKey: slot <= 4 ? 'train' : 'morale', args: {}, explicit: true };
    await recordTestTurns(db, worldId, army.generalId, turns[0]!.commandKey, turns[0]!.args as Prisma.InputJsonValue);
    await db.$transaction(async (tx) => {
      await tx.generalTurn.deleteMany({ where: { worldId, generalId: army.generalId } });
      await tx.generalTurn.createMany({
        data: turns.map((turn, slot) => ({
          ...turn,
          args: turn.args as Prisma.InputJsonValue,
          worldId,
          generalId: army.generalId,
          slot,
        })),
      });
      const event = await tx.inputEvent.findFirstOrThrow({
        where: { worldId, generalId: army.generalId, kind: 'turns.set' },
        orderBy: { id: 'desc' },
      });
      await tx.inputEvent.update({
        where: { id: event.id },
        data: { payload: { ...(event.payload as Prisma.JsonObject), turns } as unknown as Prisma.InputJsonValue },
      });
    });
  }
  await loop.advanceTo(BATTLE_PREPARATION_TICK);
  if (nationTurns) await recordFixtureNationTurns(db, worldId, nationTurns);
  for (const army of armies) {
    const campaign = (await db.world.findUniqueOrThrow({ where: { id: worldId } })).campaignState as Prisma.JsonObject;
    const units = campaign.units as Array<{ ownerId: number; troops: number; train: number; atmos: number }>;
    if (
      !units.some((unit) => unit.ownerId === army.generalId && unit.troops > 0 && unit.train >= 40 && unit.atmos >= 40)
    )
      throw Error(`전투 고정물 모집·훈련 실패: ${army.generalId} ${JSON.stringify(units)}`);
  }
  return { worldId, lease, loop, users };
}
