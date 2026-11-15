import { expect, it, vi } from 'vitest';
import type { Context } from '../context';
import { generalRouter } from './general';
import { visibilityFixture } from '../../test/visibilityFixture';

it.each([false, true])('AC-INT-28 내 장수 관직명은 기능이 %j일 때만 조회한다', async (enabled) => {
  const general = { ...(await visibilityFixture()).generals[0]!, nationId: 1, officerLevel: 11, sex: null };
  const nation = vi.fn(async () => ({ level: 7 }));
  const tx = {
    world: {
      findUnique: async () => ({
        statRules: { total: 165, min: 5, max: 100 },

        preset: null,
        runtimeOptions: null,
        replayFormat: 3,
      }),
    },
    general: { findUnique: async () => general },
    nation: { findUniqueOrThrow: nation },
  };
  const ctx = {
    db: { $transaction: async (fn: (tx: unknown) => unknown) => fn(tx) },
    user: { id: 'session-user' },
  } as unknown as Context;
  const result = await generalRouter.createCaller(ctx).mine({ worldId: 'world' });
  expect(result.general?.courtTitle).toBe(enabled ? '승상' : null);
  expect(nation).toHaveBeenCalledTimes(enabled ? 1 : 0);
});
