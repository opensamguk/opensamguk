import { expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { generalRouter } from './general';
import { visibilityFixture } from '../../test/visibilityFixture';

it.each([
  { nationId: 1, statRules: { count: 5, total: 275, min: 15, max: 90 } },
  { nationId: null, statRules: { count: 5, total: 275, min: 15, max: 90 } },
  { nationId: 1, statRules: { total: 165, min: 5, max: 100 } },
])('AC-INT-28 소속국과 실제 능력치 판을 조회한다 (%j)', async ({ nationId, statRules }) => {
  const general = { ...(await visibilityFixture()).generals[0]!, nationId, officerLevel: 11, sex: 'UNKNOWN' };
  const nation = vi.fn(async () => ({ level: 7 }));
  const tx = {
    world: {
      findUnique: async () => ({
        statRules,

        preset: null,
        runtimeOptions: null,
        replayFormat: 3,
      }),
    },
    general: { findUnique: async () => general },
    heritageAccount: { findUnique: async () => null },
    nation: { findUniqueOrThrow: nation },
  };
  const ctx = {
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    user: { id: 'session-user' },
  } as unknown as Context;
  const result = await generalRouter.createCaller(ctx).mine({ worldId: 'world' });
  expect(result.creationRules.count).toBe(statRules.count ?? 3);
  expect(result.general?.courtTitle).toBe(nationId === null ? null : '승상');
  expect(nation).toHaveBeenCalledTimes(nationId === null ? 0 : 1);
});
