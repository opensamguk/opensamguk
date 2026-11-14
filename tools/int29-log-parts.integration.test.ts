import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { logPartsToText } from '../packages/shared/src/logParts';
import { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { appendNationHistory, persistCommandReports } from '../apps/engine/src/commandPersistence';
import { storedLog } from '../apps/engine/src/logParts';
import { buildServer } from '../apps/server/src/server';
import { newSession } from '../apps/server/src/auth/session';
import { REPUTATION_POINTS } from '../packages/rules/src/balance';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const now = 1_800_000_000_000;
const app = await buildServer({ db, now: () => now, logging: false });
const ids = [randomUUID(), randomUUID()];
let worldId: string, base: string;
const cookies: string[] = [];
type Page = {
  items: Array<{
    id: string;
    source?: string;
    text: string;
    parts?: Parameters<typeof logPartsToText>[0] | null;
    partsVersion?: number | null;
    defenderId?: number | null;
    defenderPortraitId?: number | null;
    cityKey?: number | null;
  }>;
  nextCursor: string | null;
};
async function read(path: string, player = 0, cursor?: string) {
  const response = await fetch(
    `${base}/trpc/records.${path}?input=${encodeURIComponent(JSON.stringify({ worldId, ...(cursor ? { cursor } : {}) }))}`,
    { headers: { cookie: cookies[player]! } },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: { data: Page } }).result.data;
}
beforeAll(async () => {
  for (const id of ids) {
    await db.user.create({
      data: { id, email: `${id}@example.invalid`, passwordHash: 'test-only', emailVerifiedAt: new Date(now) },
    });
    const session = newSession(now);
    await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
    cookies.push(`sid=${session.token}`);
  }
  const initial = await monthlyFixture();
  Object.assign(initial.generals[0]!, { userId: ids[0], nationId: 1 });
  Object.assign(initial.generals[1]!, { userId: ids[1], nationId: 2 });
  ({ worldId } = await saveInitialWorld(db, initial, {
    name: '기록 조각 검증',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 'legacy',
  }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await app.close();
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

it('같은 tick의 국가 사건을 이어 읽고 다른 소속국에 노출하지 않는다', async () => {
  await db.$transaction(async (tx) => {
    await appendNationHistory(tx, worldId, 500, 1, '옛 사건');
    for (let i = 0; i < 65; i++) {
      const text = `누군가 살폈습니다 ${i}`;
      await appendNationHistory(tx, worldId, 500, 1, text, 'intel', [{ t: 'text', v: text }]);
    }
  });
  const items: Page['items'] = [];
  let cursor: string | null = null;
  do {
    const page = await read('nationEvents', 0, cursor ?? undefined);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(items).toHaveLength(66);
  expect(new Set(items.map((item) => item.id)).size).toBe(66);
  for (const item of items.filter((item) => item.partsVersion === 1))
    expect(item.text).toBe(logPartsToText(item.parts!));
  expect((await read('nationEvents', 1)).items).toEqual([]);
  expect(JSON.stringify(items)).not.toContain('general');
});

it('개인 기록의 null·미지원 버전과 같은 tick 페이지를 보존한다', async () => {
  for (let ordinal = 64; ordinal >= 0; ordinal--)
    await db.generalLog.create({
      data: {
        worldId,
        generalId: 1,
        tick: 700,
        sequence: 1,
        ordinal,
        commandKey: 'rest',
        kind: 'success',
        ...storedLog(`줄 ${ordinal}`, [{ t: 'text', v: `줄 ${ordinal}` }]),
      },
    });
  await db.generalLog.createMany({
    data: [
      { worldId, generalId: 1, tick: 600, commandKey: 'rest', kind: 'success', text: '옛 기록' },
      {
        worldId,
        generalId: 1,
        tick: 600,
        commandKey: 'rest',
        kind: 'success',
        text: '미지원',
        parts: [{ t: 'text', v: '미지원' }],
        partsVersion: 2,
      },
    ],
  });
  const items: Page['items'] = [];
  let cursor: string | null = null;
  do {
    const page = await read('general', 0, cursor ?? undefined);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(items).toHaveLength(67);
  expect(new Set(items.map((item) => item.id)).size).toBe(67);
  expect(items.slice(0, 65).map((item) => item.text)).toEqual(Array.from({ length: 65 }, (_, i) => `줄 ${i}`));
  expect(items.slice(-2).every((item) => item.parts === null && item.partsVersion === null)).toBe(true);
});

it('전투 보고는 실제 수비자와 도시만 기록하고 옛 행은 null이다', async () => {
  await db.$transaction((tx) =>
    persistCommandReports(tx, worldId, 800, 2, {
      effects: [],
      logs: [],
      reports: [{ generalId: 1, defenderId: 1, cityKey: 1, text: '보고', parts: [{ t: 'text', v: '보고' }] }],
    }),
  );
  await db.battleLog.create({ data: { worldId, tick: 799, attackerId: 2, generalId: 1, text: '옛 보고' } });
  const { items } = await read('battles');
  expect(items[0]).toMatchObject({ defenderId: 1, cityKey: 1, partsVersion: 1 });
  expect(items[1]).toMatchObject({
    defenderId: null,
    defenderPortraitId: null,
    cityKey: null,
    parts: null,
    partsVersion: null,
  });
});

it('평판·국가 혼합 원장은 같은 tick의 쪽 경계에서도 중복·누락이 없다', async () => {
  await db.reputationEvent.create({
    data: {
      worldId,
      generalId: 1,
      year: 190,
      month: 1,
      tick: 900,
      kind: 'domestic',
      score: REPUTATION_POINTS.domestic,
      generalName: '옛장수',
      nationId: 1,
      nationName: '옛국가',
      nationColor: '#123456',
    },
  });
  await db.publicNationEvent.createMany({
    data: Array.from({ length: 40 }, (_, i) => ({
      worldId,
      sequence: 10,
      tick: 900,
      kind: 'found',
      ...storedLog(`공개 ${i}`, [{ t: 'text', v: `공개 ${i}` }]),
    })),
  });
  const items: Page['items'] = [];
  let cursor: string | null = null;
  do {
    const page = await read('activity', 0, cursor ?? undefined);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  expect(items).toHaveLength(41);
  expect(items[0]!.source).toBe('reputation');
  expect(new Set(items.map((item) => `${item.source}:${item.id}`)).size).toBe(41);
  for (const item of items) expect(item.text).toBe(logPartsToText(item.parts!));
});
