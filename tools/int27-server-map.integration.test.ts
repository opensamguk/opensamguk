import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { buildInitialWorld, initialReplayState, buildSupplyLedger } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { publicMapConfig } from '../packages/shared/src/publicMap';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { persistPublicMap } from '../apps/engine/src/publicMap';
import { persistPublicNationEvents } from '../apps/engine/src/nationArchive';
import { acquireLease, releaseLease, type Lease } from '../apps/engine/src/lease';
import { buildServer } from '../apps/server/src/server';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let now = Date.now();
const app = await buildServer({ db, now: () => now, logging: false });
let worldId: string | undefined;
let lease: Lease | undefined;
const minute = 60_000;
const config = publicMapConfig(process.env);
const read = async (path: string) =>
  JSON.parse(await readFile(new URL(`../resources/${path}`, import.meta.url), 'utf8'));
beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await app.close();
  if (lease) await releaseLease(db, lease);
  if (worldId) await db.world.delete({ where: { id: worldId } });
  await db.$disconnect();
});

it('AC-INT-27·28·AC-M2-20 FIELD 저장·재적재와 같은 턴 사건의 지연 경계를 실제 DB·HTTP에서 지킨다', async () => {
  const map = await read('map/san10-expanded.json');
  const scenario = {
    ...(await read('scenario/san10-empty.json')),
    id: `int27-${randomUUID()}`,
    requiredMap: map.id,
    general: [],
    nation: [],
  };
  const city = map.sites.find((row: { kind: string; level: number }) => row.kind === 'CITY' && row.level >= 4);
  scenario.nation = [['시험국', '#123456', 0, 0, '', 0, '', 1, [city.name]]];
  const initial = buildInitialWorld({
    map,
    scenario,
    unitSet: await read('unitset/expanded.json'),
    statRules: await read('scenario/five-stats.json'),
    seed: 'int27-db',
    mapKey: 'san10-expanded@3',
  });
  ({ worldId } = await saveInitialWorld(db, initial, {
    name: 'INT-27 DB 시험',
    turnTermMinutes: 60,
    endYear: null,
    replayFormat: 3,
  }));
  const stored = await readWorldState(db, worldId);
  const saved = await db.world.findUniqueOrThrow({ where: { id: worldId } });
  expect((saved.campaignState as { supplyLedger?: unknown }).supplyLedger).toEqual(
    buildSupplyLedger(initial.operationalMap!),
  );
  const locationColumn = await db.$queryRaw<Array<{ is_generated: string }>>`
    SELECT is_generated FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'General' AND column_name = 'cityAnchorKey'`;
  expect(locationColumn).toEqual([{ is_generated: 'ALWAYS' }]);
  expect(stored.cities.filter((row) => row.kind === 'FIELD')).toHaveLength(38);
  expect(stored.cities.filter((row) => row.kind === 'FIELD').every((row) => row.nationId === null)).toBe(true);
  expect(stored.cities.filter((city) => city.parentCityKey != null)).toHaveLength(105);
  expect(stored.cities.every((city) => city.state === 0 && city.stateTerm === 0)).toBe(true);
  expect(hashState(stored)).toBe(hashState(initial));
  const before = initialReplayState(initial, { policy: { version: 1, turnTermMinutes: 60 } }).state,
    next = structuredClone(before);
  const field = Object.values(next.cities).find((row) => row.kind === 'FIELD')!;
  field.nationId = 1;
  await db.world.update({ where: { id: worldId }, data: { status: 'RUNNING' } });
  lease = (await acquireLease(db, worldId, randomUUID(), 120_000))!;
  now += (config.intervalMinutes + 1) * minute;
  await db.$transaction(async (tx) => {
    await tx.city.update({
      where: { worldId_cityKey: { worldId: worldId!, cityKey: field.cityKey } },
      data: { nationId: 1 },
    });
    await persistPublicNationEvents(tx, worldId!, before, next, { sequence: 1, tick: 0 });
    await persistPublicMap(tx, lease!, next, 0, now, config);
  });
  await db.publicNationEvent.create({
    data: { worldId, sequence: 2, tick: 0, kind: 'capture', text: '같은 턴의 나중 사건' },
  });
  const request = async (path: string, input?: unknown) => {
    const res = await app.inject({
      method: 'GET',
      url: `/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json().result.data;
  };
  now += config.delayMinutes * minute - 1;
  expect((await request('lobby.headlines', { worldId })).items).toEqual([]);
  now++;
  const headlines = await request('lobby.headlines', { worldId });
  expect(headlines.items).toHaveLength(1);
  expect(headlines.items[0]).toMatchObject({ kind: 'capture', nations: [{ id: 1, name: '시험국', color: '#123456' }] });
  const maps = await request('world.publicMaps');
  const snapshot = maps.worlds.find((row: { id: string }) => row.id === worldId).map;
  expect(snapshot.emperorCityKey).toBeNull();
  expect(
    snapshot.cities.every((city: { state: number; stateTerm: number }) => city.state === 0 && city.stateTerm === 0),
  ).toBe(true);
  expect(snapshot.cities.filter((city: { parentCityKey: number | null }) => city.parentCityKey !== null)).toHaveLength(
    105,
  );
  expect(snapshot.siteOwnership).toContainEqual({ anchorKey: field.cityKey, nationId: 1 });
  expect(
    snapshot.operationalMap.sites.filter(
      (row: { kind: string; anchorKey?: number }) => row.kind === 'FIELD' && row.anchorKey !== undefined,
    ),
  ).toHaveLength(38);
});
