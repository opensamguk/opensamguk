import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { emptyCampaignState, emptyCityResourcesState, toWorldState, type WorldState } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { loadInitialWorld } from './world/resources';
import { persistCityResourcesState, readStoredCityResources } from './cityResourcesState';

// 이 검사는 저장 어댑터와 실제 PG의 원자성만 맡는다. 정식 한 기수 인수를 대신하지 않는다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('도시 자원 저장 전용 테스트 DB가 필요합니다.');
const parsed = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
  !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
  !['', '5432', '5433', '5434', '5435'].includes(parsed.port) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(parsed.pathname) ||
  parsed.searchParams.has('host') ||
  parsed.searchParams.has('port')
)
  throw new Error('loopback 테스트 DB 주소와 이름을 확인하세요.');
const db = createDb(url);
const ids: string[] = [];
let source: Awaited<ReturnType<typeof monthlyFixture>>;
beforeAll(async () => {
  source = await loadInitialWorld({
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'city-storage-contract',
  });
});
afterAll(async () => {
  try {
    await db.world.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await db.$disconnect();
  }
});
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
async function fixture(enabled = true) {
  const world = toWorldState(source),
    seed = `city-storage-${randomUUID()}`;
  world.ruleFeatures = enabled
    ? [
        'campaign-assignment-v2',
        'campaign-v1',
        'city-resources-v1',
        'five-stats',
        'operational-map',
        'personnel',
        'policy',
      ]
    : [];
  if (enabled) {
    world.campaign = emptyCampaignState(world, seed, 'storage-contract');
    world.cityResources = emptyCityResourcesState(world);
  }
  const row = await db.world.create({
    data: {
      name: 'AC-INT-18B 저장 계약',
      scenarioKey: source.scenarioKey,
      mapKey: source.mapKey,
      unitSetKey: source.unitSetKey,
      seed,
      startYear: source.startYear,
      initialStateHash: 'storage-contract-only',
      statRules: json(source.statRules),
      unitSet: json(source.unitSet),
      turnTermMinutes: 60,
      replayFormat: enabled ? 3 : 1,
      ruleFeatures: world.ruleFeatures,
      ...(enabled
        ? {
            campaignState: json(world.campaign),
            operationalMap: json(source.operationalMap),
            cityResourcesState: json(world.cityResources),
          }
        : {}),
    },
  });
  ids.push(row.id);
  return { row, world };
}
function changed(before: WorldState) {
  const next = structuredClone(before);
  next.cityResources!.cities[Object.keys(next.cities)[0]!] = {
    gold: 123,
    rice: 456,
    garrison: [{ crewType: 1100, troops: 300, train: 40, atmos: 60 }],
  };
  return next;
}
const locked = async (id: string, before: WorldState, next: WorldState) =>
  db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${id} FOR UPDATE`;
    await persistCityResourcesState(tx, id, before, next, [1100]);
  });

describe('AC-INT-18B 실제 PostgreSQL 도시 원장', () => {
  it('기존 판은 NULL이고 새 판은 0으로 시작해 연결을 다시 열어도 보존된다', async () => {
    const old = await fixture(false),
      current = await fixture();
    expect(old.row.cityResourcesState).toBeNull();
    expect(current.row.cityResourcesState).toEqual(emptyCityResourcesState(current.world));
    const reopened = createDb(url);
    try {
      const row = await reopened.world.findUniqueOrThrow({ where: { id: current.row.id } });
      expect(readStoredCityResources(row.cityResourcesState, current.world, [1100])).toEqual(
        current.world.cityResources,
      );
      expect((await reopened.world.findUniqueOrThrow({ where: { id: old.row.id } })).cityResourcesState).toBeNull();
    } finally {
      await reopened.$disconnect();
    }
  });
  it('원장 뒤 다른 변경이 실패하면 전부 롤백하고 다른 월드는 그대로다', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${f.row.id} FOR UPDATE`;
        await persistCityResourcesState(tx, f.row.id, f.world, changed(f.world), [1100]);
        await tx.world.update({ where: { id: f.row.id }, data: { clockTick: 50 } });
        throw new Error('after-city-save');
      }),
    ).rejects.toThrow('after-city-save');
    const row = await db.world.findUniqueOrThrow({ where: { id: f.row.id } });
    expect(row.cityResourcesState).toEqual(f.world.cityResources);
    expect(row.clockTick).toBe(0);
    expect((await db.world.findUniqueOrThrow({ where: { id: other.row.id } })).cityResourcesState).toEqual(
      other.world.cityResources,
    );
  });
  it('같은 이전 JSON을 쓴 동시 요청은 하나만 저장하고 늦은 요청은 실패한다', async () => {
    const f = await fixture(),
      next = changed(f.world);
    const results = await Promise.allSettled([locked(f.row.id, f.world, next), locked(f.row.id, f.world, next)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const row = await db.world.findUniqueOrThrow({ where: { id: f.row.id } });
    expect(readStoredCityResources(row.cityResourcesState, next, [1100])).toEqual(next.cityResources);
  });
  it('DB 제약이 OFF 비NULL·ON NULL·의존 누락·형식 변경을 막는다', async () => {
    const f = await fixture(),
      old = await fixture(false);
    await expect(
      db.world.update({ where: { id: old.row.id }, data: { cityResourcesState: json(f.world.cityResources) } }),
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "World" SET "cityResourcesState" = NULL WHERE id = ${f.row.id}`,
    ).rejects.toThrow();
    for (const data of [
      { ruleFeatures: f.row.ruleFeatures.filter((key) => key !== 'campaign-assignment-v2') },
      { cityResourcesState: json({ version: 2, cities: {} }) },
      { cityResourcesState: json({ version: 1, cities: [] }) },
      { cityResourcesState: {} },
    ])
      await expect(db.world.update({ where: { id: f.row.id }, data })).rejects.toThrow();
    expect((await db.world.findUniqueOrThrow({ where: { id: f.row.id } })).cityResourcesState).toEqual(
      f.world.cityResources,
    );
  });
});
