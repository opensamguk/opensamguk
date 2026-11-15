import { describe, expect, it } from 'vitest';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import {
  checkReplayOrigin,
  initialReplayState,
  runReplayAction,
  providedRuleKeys,
  type ReplayOriginV3,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { monthlyFixture } from '../../test/monthlyFixture';
import { prepareInitialWorld, savePreparedInitialWorld, readWorldState } from './persistence';

describe('AC-INT-28 전체 규칙 저장 계약', () => {
  it.each([false, true])('안개 %j에서도 모든 상태를 저장하고 원생성 해시를 복원한다', async (fogOfWar) => {
    const initial = await monthlyFixture();
    initial.fogOfWar = fogOfWar;
    initial.scenarioKey = 'always-on-test';
    const rows: Record<string, Record<string, unknown>[]> = {};
    let stored: Record<string, unknown> = {};
    const tx: Record<string, unknown> = {
      world: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          stored = { ...data, id: 'always-on', createdAt: new Date(0) };
          return stored;
        },
        findUniqueOrThrow: async () => stored,
      },
      $queryRaw: async () => rows.worldExtSlice,
    };
    for (const table of ['worldExtSlice', 'nation', 'city', 'general', 'generalTurn', 'diplomacy', 'nationTurn']) {
      rows[table] = [];
      tx[table] = {
        create: async ({ data }: { data: Record<string, unknown> }) => rows[table]!.push(data),
        createMany: async ({ data }: { data: Record<string, unknown>[] }) =>
          rows[table]!.push(...structuredClone(data)),
        findMany: async () =>
          rows[table]!.map((row) => {
            const result = { ...row };
            if (table === 'general') {
              delete result.defaultPolicy;
              delete result.lastActiveTick;
            }
            return result;
          }),
        update: async ({ where, data }: { where: { worldId_id: { id: number } }; data: object }) =>
          Object.assign(
            rows[table]!.find((row) => row.id === where.worldId_id.id)!,
            data,
          ),
      };
    }
    const prepared = prepareInitialWorld(initial, { name: '상시 규칙', turnTermMinutes: 60, endYear: null });
    await savePreparedInitialWorld(tx as unknown as Prisma.TransactionClient, prepared, undefined, false);
    expect(stored).not.toHaveProperty('ruleFeatures');
    expect(stored.fogOfWar).toBe(fogOfWar);
    const origin = stored.replayOrigin as ReplayOriginV3;
    checkReplayOrigin(origin);
    const replay = initialReplayState(origin.initial, origin.featureData);
    const fields = {
      campaign: 'campaignState',
      cityResources: 'cityResourcesState',
      cityRuins: 'cityRuinsState',
      logistics: 'logisticsState',
      governance: 'governanceState',
      lineage: 'lineageState',
      equipment: 'equipmentState',
      stratagemCards: 'stratagemCardsState',
      nationLifecycle: 'nationLifecycleState',
      nationResearch: 'nationResearchState',
      nationStrategy: 'nationStrategyState',
      preparedTurns: 'preparedTurnsState',
      officeEffects: 'officeEffects',
    };
    for (const [state, field] of Object.entries(fields))
      expect(stored[field]).toEqual(replay.state[state as keyof typeof replay.state]);
    expect(rows.worldExtSlice).toEqual([{ worldId: 'always-on', key: 'intel', value: {} }]);
    expect(runReplayAction(replay, initial.seed, initial.unitSet).state.fogOfWar).toBe(fogOfWar);
    const db = { $transaction: async (read: (tx: unknown) => unknown) => read(tx) } as unknown as PrismaClient;
    const restored = await readWorldState(db, 'always-on');
    expect(restored).toEqual(origin.initial);
    expect(hashState(restored)).toBe(prepared.stateHash);
    expect(providedRuleKeys).toHaveLength(32);
  });
});
