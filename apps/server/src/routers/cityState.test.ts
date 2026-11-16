import { readFileSync } from 'node:fs';
const archive = JSON.parse(
  readFileSync(new URL('../../../engine/test/fixtures/replay-v3.json', import.meta.url), 'utf8'),
);
const operationalMap = archive.origin.initial.operationalMap;
import { expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { worldRouter } from './world';
import { commandsRouter } from './commands';
import { toWorldState } from '@opensamguk/rules';
import { visibilityFixture } from '../../test/visibilityFixture';
import { publicMapInfo } from '../visibility';
import { recordsRouter } from './records';
const fixture = await visibilityFixture();
function commandWorld() {
  const world = toWorldState(fixture);
  world.cities[1]!.connections = [2];
  return world;
}

const id = '10000000-0000-4000-8000-000000000001';
vi.mock('../game/queries', async (original) => ({
  ...(await original<object>()),
  readView: vi.fn(async () => commandWorld()),
}));

it.each([false, true])('AC-INT-27 안개 %j에서 지도 상태·현 소속·천자 소재지를 공개 범위대로 읽는다', async (fog) => {
  const world = commandWorld();
  const cities = Object.values(world.cities).map((city) => ({
    ...city,
    kind: 'CITY',
    state: 32,
    stateTerm: 3,
    parentCityKey: city.cityKey === 2 ? 1 : null,
  }));
  const info = {
    id,

    fogOfWar: fog,
    operationalMap: operationalMap,
    replayOrigin: archive.origin,
    replayFormat: 3,
    cityRuinsState: { version: 1, cities: [] },
    mapKey: 'test',
    governanceState: { config: { seatCityKey: 1 } },
  };
  const tx = {
    world: { findUnique: async () => info, findUniqueOrThrow: async () => info },
    city: { findMany: async () => cities },
    gameResource: { findMany: async () => [] },
    nation: { findMany: async () => Object.values(world.nations) },
    general: { findMany: async () => [], findUnique: async () => ({ ...world.generals[1], removedAt: null }) },
  };
  const ctx = {
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    user: { id: 'session-user' },
  } as unknown as Context;
  const map = await worldRouter.createCaller(ctx).map({ worldId: id });
  expect(map.emperorCityKey).toBe(1);
  expect(map.cities[0]).toMatchObject({ state: 32, stateTerm: 3, parentCityKey: null, detached: false });
  expect(map.cities[1]).toMatchObject({ parentCityKey: 1, detached: true });
  expect(map.cities[1]!.state).toBe(fog ? undefined : 32);
});

it('AC-INT-28 경로 조회는 세션 장수를 쓰고 행위자 주입·비로그인을 거부한다', async () => {
  const tx = {
    world: { findUnique: async () => ({ id, status: 'RUNNING' }) },
    general: { findUnique: vi.fn(async () => ({ id: 1, removedAt: null, nextTurnTick: 100 })) },
  };
  const ctx = {
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    user: { id: 'session-user' },
  } as unknown as Context;
  const caller = commandsRouter.createCaller(ctx);
  expect(await caller.attackTargets({ worldId: id })).toContainEqual({
    cityKey: 2,
    path: [1, 2],
    turns: 1,
    sweptCounties: [],
    blockedBy: null,
  });
  expect(tx.general.findUnique).toHaveBeenCalledWith({
    where: { worldId_userId: { worldId: id, userId: 'session-user' } },
  });
  await expect(caller.moveTargets({ worldId: id, generalId: 2 } as never)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  await expect(
    commandsRouter.createCaller({ ...ctx, user: null }).attackTargets({ worldId: id }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});

it('AC-INT-27 공개 지도 사본의 상태·부속 현·천자 필드는 검증 후 보존한다', () => {
  const data = {
    emperorCityKey: 1,
    cities: [
      {
        key: '1',
        name: '업',
        level: 5,
        x: 0,
        y: 0,
        nationId: 1,
        links: [],
        state: 43,
        stateTerm: 3,
        parentCityKey: null,
        detached: false,
      },
    ],
    nations: [],
  };
  expect(publicMapInfo(data)).toMatchObject(data);
  expect(publicMapInfo({ ...data, cities: [{ ...data.cities[0]!, state: 50 }] })).toBeNull();
});

it('AC-INT-27 재해와 호황을 세계 기록에서 같은 kind로 읽는다', async () => {
  const tx = {
    world: { findUnique: async () => ({ startYear: 191 }) },
    publicNationEvent: {
      findMany: async () =>
        ['disaster', 'boom'].map((kind, index) => ({ id: BigInt(index + 1), tick: 10000, kind, text: kind })),
    },
  };
  const ctx = {
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    user: { id: 'session-user' },
  } as unknown as Context;
  const result = await recordsRouter.createCaller(ctx).activity({ worldId: id, scope: 'world' });
  expect(result.items.map((item) => item.kind)).toEqual(['disaster', 'boom']);
});
