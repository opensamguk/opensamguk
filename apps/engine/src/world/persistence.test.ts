import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../../test/monthlyFixture';
import { saveInitialWorld } from './persistence';
import { resourceHash } from '../replay';

describe('T2-26 생성 형식', () => {
  it.each([undefined, 1, 3] as const)('생성 옵션 %s는 기능 없는 초기 해시를 유지한다', async (replayFormat) => {
    const initial = await monthlyFixture();
    const create = vi.fn(async (data: unknown) => {
      void data;
      return { id: 'created' };
    });
    const table = { createMany: vi.fn(async () => ({ count: 0 })), update: vi.fn(async () => ({})) };
    const tx = { world: { create }, city: table, general: table, nation: table, diplomacy: table, nationTurn: table };
    const db = { $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaClient;
    const result = await saveInitialWorld(db, initial, {
      ...(replayFormat !== undefined ? { replayFormat } : {}),
      name: '생성',
      turnTermMinutes: 60,
      endYear: null,
    });
    expect(result.stateHash).toBe(hashState(initial));
    expect(create.mock.calls[0]![0]).toMatchObject({
      data: {
        replayFormat: replayFormat ?? 3,
        ruleFeatures: [],
        replayOrigin: {
          version: replayFormat ?? 3,
          initial,
          initialStateHash: hashState(initial),
          resourceHash: resourceHash(initial),
        },
      },
    });
  });
  it('모르는 기능·빈 자료·구형 기능은 쓰기 전에 거부한다', async () => {
    const transaction = vi.fn();
    const db = { $transaction: transaction } as unknown as PrismaClient;
    const initial = await monthlyFixture();
    for (const extra of [
      { ruleFeatures: ['unknown'] },
      { replayFormat: 1 as const, ruleFeatures: ['unknown'] },
      { featureData: {} },
      { featureData: { unknown: true } },
      { replayFormat: 2 as 1 },
      { ruleFeatures: null as unknown as string[] },
    ]) {
      await expect(
        saveInitialWorld(db, initial, { name: '거부', turnTermMinutes: 60, endYear: null, ...extra }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    }
    await expect(
      saveInitialWorld(db, { ...initial, ruleFeatures: [] }, { name: '빈 목록', turnTermMinutes: 60, endYear: null }),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});
