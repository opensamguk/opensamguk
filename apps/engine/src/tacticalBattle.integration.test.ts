import { afterAll, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { warFixture } from '../test/warFixture';
import { monthlyFixture } from '../test/monthlyFixture';
import { prepareBattleFixture } from '../test/battleFixture';
import { recordTestTurns } from '../test/seasonFixture';
import { settlePendingBattle } from '../test/tacticalSettlement';
import { releaseLease, renewLease } from './lease';
import { exportReplay, replayArchive } from './replay';
import { loadWorld } from './worldLoader';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const worlds: string[] = [];
const users: string[] = [];
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: worlds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});

it('AC-P2-24·AC-INT-28 마지막 도시 전술 점령은 국가 삭제 전에 직책을 정리하고 정산 tick으로 재생한다', async () => {
  const initial = await warFixture();
  initial.startYear = 194;
  initial.commandMeta = { nextNationId: 3, offers: {}, lastNationRecruitmentLock: { fromYear: 195 } };
  initial.operationalMap = (await monthlyFixture()).operationalMap!;
  initial.cities[1]!.wall = initial.cities[1]!.defence = 0;
  for (const city of initial.cities) {
    city.x = city.cityKey * 64;
    city.y = 64;
    city.kind = 'CITY';
  }
  for (const site of initial.operationalMap!.sites) {
    if (site.kind !== 'CITY') continue;
    const city = initial.cities.find((row) => row.cityKey === site.anchorKey)!;
    site.level = city.level;
    site.region = city.region;
    site.position = { x: city.x, y: city.y };
    for (const field of ['population', 'security', 'wall', 'defence'] as const) {
      site.initial![field] = city[field];
      site.max![field] = city[`${field}Max`];
    }
    for (const field of ['commerce', 'agriculture'] as const) {
      site.initial![field] = site.max![field] = 2_000_000;
    }
    site.initial!.wall = city.wall;
    site.initial!.defence = city.defence;
  }
  initial.operationalMap!.routes = initial.cities.flatMap((city) =>
    city.connections
      .filter((key) => city.cityKey < key)
      .map((key) => ({
        id: `route:${city.cityKey}:${key}`,
        from: `city:${city.cityKey}`,
        to: `city:${key}`,
        mode: 'LAND' as const,
        direction: 'BOTH' as const,
        enabled: true,
      })),
  );
  const {
    worldId,
    loop,
    lease,
    users: createdUsers,
  } = await prepareBattleFixture(db, initial, [{ generalId: 1, troops: 1000, crewType: 1100 }]);
  worlds.push(worldId);
  users.push(...createdUsers);
  try {
    expect(await db.nationOffice.count({ where: { worldId, nationId: 2 } })).toBeGreaterThan(0);
    await recordTestTurns(db, worldId, 1, 'attack', { cityKey: 2 });
    const actor = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    await loop.advanceTo(actor.nextTurnTick);
    const attackLog = await db.generalLog.findFirstOrThrow({
      where: { worldId, generalId: 1, tick: actor.nextTurnTick, commandKey: 'attack' },
    });
    expect(attackLog.kind, attackLog.text).toBe('success');
    expect(await db.battle.count({ where: { worldId } })).toBe(1);
    expect(await db.nation.count({ where: { worldId, id: 2 } })).toBe(1);
    // 194년 출병과 195년 정산을 구분한다. 잠금의 기준은 실제 국가 소멸 tick이다.
    const settlementTick = 120_000;
    await loop.advanceTo(settlementTick);
    await settlePendingBattle(db, worldId);
    expect(await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 2 } } })).toMatchObject({
      nationId: 1,
    });
    expect(await db.nation.count({ where: { worldId, id: 2 } })).toBe(0);
    expect(await db.nationOffice.count({ where: { worldId, nationId: 2 } })).toBe(0);
    expect(await db.nationOfficeTurn.count({ where: { worldId, nationId: 2 } })).toBe(0);
    expect(
      await db.removedNation.findUniqueOrThrow({ where: { worldId_nationId: { worldId, nationId: 2 } } }),
    ).toMatchObject({ removedTick: settlementTick });
    expect((await db.$transaction((tx) => loadWorld(tx, worldId))).commandMeta?.lastNationRecruitmentLock).toEqual({
      fromYear: 195,
      blockedNationId: 1,
    });
    expect(await db.battle.findFirstOrThrow({ where: { worldId } })).toMatchObject({
      state: { settled: true, result: 'attack' },
    });
    await renewLease(db, lease);
    await loop.advanceTo(130_000);
    const archive = await exportReplay(db, worldId);
    expect(archive.inputs.filter((row) => row.kind === 'battle.step').at(-1)?.tick).toBe(settlementTick);
    expect(replayArchive(archive, archive.months.length)).toEqual(
      archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })),
    );
    const invalid = structuredClone(archive);
    invalid.inputs.find((row) => row.kind === 'battle.step')!.tick = null;
    expect(() => replayArchive(invalid, invalid.months.length)).toThrow('입력의 처리 tick을 확인하세요.');
    const outside = structuredClone(archive);
    outside.inputs.find((row) => row.kind === 'battle.step')!.tick = 0;
    expect(() => replayArchive(outside, outside.months.length)).toThrow(
      '입력의 처리 tick이 재생 월 창을 벗어났습니다.',
    );
  } finally {
    await releaseLease(db, lease);
  }
}, 60_000);
