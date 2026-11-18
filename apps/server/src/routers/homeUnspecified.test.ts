import { expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { homeRouter } from './home';
import { visibilityFixture } from '../../test/visibilityFixture';
vi.mock('../game/queries', () => ({
  readView: vi.fn(async () => ({ cities: {}, generals: {}, nations: {}, diplomacies: [] })),
}));
vi.mock('../game/cityScale', () => ({ readCityScaleProjection: vi.fn(async () => new Map()) }));
it('AC-INT-28 위치 미지정 장수의 홈은 city:null이며 도시0을 조회하지 않는다', async () => {
  const general = {
    ...(await visibilityFixture()).generals[0]!,
    cityKey: 0,
    nationId: null,
    removedAt: null,
    sex: null,
    defaultPolicy: null,
  };
  const city = vi.fn(async () => {
    throw Error('City zero must not be queried');
  });
  const tx = {
    world: {
      findUniqueOrThrow: async () => ({ replayFormat: 3 }),
      findUnique: async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'PAUSED',

        startYear: 191,
        clockMode: 'REALTIME',
        clockTick: 0,
        clockAnchorAt: null,
        turnTermMinutes: 60,
        preset: null,
        runtimeOptions: null,
      }),
    },
    general: { findUnique: async () => general },
    city: { findUniqueOrThrow: city },
    generalTurn: {
      findMany: async () =>
        Array.from({ length: 30 }, (_, slot) => ({ slot, commandKey: 'rest', args: {}, explicit: false })),
    },
    generalLog: { findMany: async () => [] },
  };
  const ctx = {
    db: { $transaction: async (read: (tx: unknown) => unknown) => read(tx) },
    user: { id: 'owner' },
    now: 0,
  } as unknown as Context;
  const result = await homeRouter.createCaller(ctx).get({ worldId: '11111111-1111-4111-8111-111111111111' });
  expect(result.city).toBeNull();
  expect(result.general.cityKey).toBe(0);
  expect(result.general.defense.troops).toBe(0);
  expect(city).not.toHaveBeenCalled();
});
