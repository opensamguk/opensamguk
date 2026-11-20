import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { type WorldState } from '@opensamguk/rules';
import { monthlyFixture } from '../test/monthlyFixture';
import { saveInitialWorld } from './world/persistence';
import { loadReplayState } from './monthly';
import { loadInitialWorldFromDb } from './world/resources';
import { persistCampaignState, readStoredCampaign } from './campaignState';

// AC-INT-06 저장 계약만 검사한다. 정식 시나리오/API/엔진·리스 인수 증거와 구분한다.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('휘하 저장 전용 테스트 DB가 필요합니다.');
const parsed = new URL(url);
if (
  !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
  !['localhost', '127.0.0.1'].includes(parsed.hostname) ||
  !['', '5432', '5433', '5561'].includes(parsed.port) ||
  !/^\/[a-z][a-z0-9_]*_test$/.test(parsed.pathname) ||
  parsed.searchParams.has('host') ||
  parsed.searchParams.has('port')
)
  throw new Error('loopback 테스트 DB 주소와 이름을 확인하세요.');
const db = createDb(url);
const ids: string[] = [];
let initial: Awaited<ReturnType<typeof monthlyFixture>>;
beforeAll(async () => {
  initial = await loadInitialWorldFromDb(db, {
    scenario: 'integration191',
    map: 'integration',
    statRules: 'five-stats',
    portraitMap: '191-map',
    seed: 'campaign-storage-source',
  });
});
afterAll(async () => {
  await db.world.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));

async function fixture() {
  const init = structuredClone(initial);
  init.seed = `storage-${randomUUID()}`;
  const { worldId } = await saveInitialWorld(db, init, {
    name: '휘하 저장 계약',
    turnTermMinutes: 60,
    endYear: null,
  });
  ids.push(worldId);
  const row = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  const { state: world } = await db.$transaction((tx) => loadReplayState(tx, worldId));
  return { row, world };
}

function changed(before: WorldState): WorldState {
  const next = structuredClone(before);
  const owner = Object.values(next.generals)[0]!;
  next.campaign!.revision++;
  next.campaign!.nextUnitId = 2;
  next.campaign!.units = [
    { id: 1, ownerId: owner.id, commanderId: owner.id, troops: 100, crewType: 1100, train: 50, atmos: 50 },
  ];
  return next;
}

describe('AC-INT-06 실제 PostgreSQL 휘하 스냅샷', () => {
  it('필수 휘하 상태는 연결을 다시 열어도 그대로 읽는다', async () => {
    const old = await fixture(),
      current = await fixture();
    expect(old.row.campaignState).toEqual(old.world.campaign);
    const reopened = createDb(url);
    try {
      const row = await reopened.world.findUniqueOrThrow({ where: { id: current.row.id } });
      expect(readStoredCampaign(row.campaignState, current.world, row.seed)).toEqual(current.world.campaign);
      expect((await reopened.world.findUniqueOrThrow({ where: { id: old.row.id } })).campaignState).toEqual(
        old.world.campaign,
      );
    } finally {
      await reopened.$disconnect();
    }
  });
  it('턴 후반 오류면 상태 변경을 롤백하고 다른 월드의 병력은 바꾸지 않는다', async () => {
    const f = await fixture(),
      other = await fixture();
    const next = changed(f.world);
    await expect(
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${f.row.id} FOR UPDATE`;
        await persistCampaignState(tx, f.row.id, f.world, next);
        throw new Error('after-campaign-save');
      }),
    ).rejects.toThrow('after-campaign-save');
    expect((await db.world.findUniqueOrThrow({ where: { id: f.row.id } })).campaignState).toEqual(f.world.campaign);
    expect((await db.world.findUniqueOrThrow({ where: { id: other.row.id } })).campaignState).toEqual(
      other.world.campaign,
    );
  });
  it('같은 이전 상태의 동시 변경은 하나만 저장하며 늦은 변경은 전체 롤백한다', async () => {
    const f = await fixture(),
      next = changed(f.world);
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${f.row.id} FOR UPDATE`;
          await persistCampaignState(tx, f.row.id, f.world, next);
        }),
      ),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const row = await db.world.findUniqueOrThrow({ where: { id: f.row.id } });
    expect(readStoredCampaign(row.campaignState, next, row.seed)).toEqual(next.campaign);
  });
  it('DB는 필수 상태 누락·다른 시드·다른 판·빈 상태를 거부한다', async () => {
    const f = await fixture(),
      old = await fixture();
    await expect(db.world.update({ where: { id: old.row.id }, data: { campaignState: json(null) } })).rejects.toThrow();
    for (const patch of [
      { campaignState: json(null) },
      { campaignState: json({ ...f.world.campaign, seed: 'other-seed' }) },
      { campaignState: json({ ...f.world.campaign, version: 2 }) },
      { campaignState: {} },
    ])
      await expect(db.world.update({ where: { id: f.row.id }, data: patch })).rejects.toThrow();
    expect((await db.world.findUniqueOrThrow({ where: { id: f.row.id } })).campaignState).toEqual(f.world.campaign);
  });
});
