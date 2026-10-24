// replay-v2-53dd348.json은 53dd348 엔진과 실제 PostgreSQL에서 사용자 생성 → saveInitialWorld → controlClock start → acquireLease → 입력·연감·worldResult 삽입 → exportReplay 순서로 만들었다.
import { vi } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import {
  applyRecordedInput,
  buildYearbook,
  emptyTurns,
  initialReplayStateWithRegistry,
  monthlyDate,
  nextGameAction,
  ruleRegistry,
  runReplayAction,
  type RecordedInput,
  type ReplayOriginV3,
  type ReplayState,
  type RuleRegistry,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { resourceHashV3, type ReplayArchiveV2, type ReplayArchiveV3 } from '../src/replay';
import { monthlyFixture } from './monthlyFixture';

export const featureRegistry: RuleRegistry = {
  features: ['test-a', 'test-b', 'test-c', 'test-d'].map((key) => ({
    key,
    requires: key === 'test-c' ? ['test-a'] : [],
    conflicts: key === 'test-d' ? ['test-b'] : [],
    checkOrigin({ data }) {
      if (data !== undefined && data !== 'fixture') throw new Error('시험 기능 자료 오류');
    },
    ...(key === 'test-a'
      ? {
          checkArchive({ inputs }: { inputs: readonly RecordedInput[] }) {
            if (inputs.some((input) => JSON.stringify(input.payload).includes('#'))) throw new Error('시험 금지 문자');
          },
        }
      : {}),
    initReplayState(replay) {
      return { ...replay, [key]: 0 };
    },
  })),
  inputKinds: [
    ...ruleRegistry.inputKinds,
    ...['test-a', 'test-b', 'test-c', 'test-d'].flatMap((feature) =>
      (['direct', 'queued'] as const).map((route) => ({
        kind: `${feature}.${route}`,
        feature,
        route,
        apply(replay: ReplayState, input: RecordedInput) {
          const next = structuredClone(replay) as ReplayState & Record<string, unknown>;
          next[feature] = (next[feature] as number) + (input.payload as { value: number }).value;
          return next;
        },
      })),
    ),
  ],
};

export async function featureArchive(features: string[]): Promise<ReplayArchiveV3> {
  const initial = await monthlyFixture();
  if (features.length) initial.ruleFeatures = [...features];
  const origin: ReplayOriginV3 = { version: 3, initial, initialStateHash: hashState(initial), resourceHash: '' };
  origin.resourceHash = resourceHashV3(origin);
  const archive: ReplayArchiveV3 = {
    version: 3,
    origin,
    config: { endYear: null, outcomeFromSequence: 0 },
    inputs: [],
    months: [],
    end: null,
    afterEnd: [],
  };
  let replay = initialReplayStateWithRegistry(initial, featureRegistry);
  let sequence = 0;
  for (let month = 0; month < 12; month++) {
    const core: RecordedInput & { tick: null } = {
      sequence: ++sequence,
      generalId: initial.generals[0]!.id,
      kind: 'turns.set',
      status: 'APPLIED',
      tick: null,
      payload: { turns: emptyTurns(), revision: replay.revisions[initial.generals[0]!.id] },
      result: { revision: replay.revisions[initial.generals[0]!.id]! + 1 },
    };
    replay = applyRecordedInput(replay, core, featureRegistry);
    archive.inputs.push(core);
    for (const feature of features)
      for (const route of ['queued', 'direct']) {
        const input = {
          sequence: ++sequence,
          generalId: null,
          kind: `${feature}.${route}`,
          status: 'APPLIED' as const,
          tick: route === 'queued' ? replay.monthlyTick + 10 : null,
          payload: { value: 1 },
          result: {},
        };
        replay = applyRecordedInput(replay, input, featureRegistry);
        archive.inputs.push(input);
      }
    while (replay.monthlyTick === month * 10000) {
      const action = nextGameAction(replay);
      sequence++;
      replay = runReplayAction(replay, initial.seed, initial.unitSet);
      if (action.kind === 'monthly')
        archive.months.push({
          tick: action.tick,
          ...monthlyDate(initial.startYear, action.tick),
          sequence,
          stateHash: hashState(replay),
          data: buildYearbook(replay.state, monthlyDate(initial.startYear, action.tick).year),
        });
    }
  }
  return archive;
}

export function asV3(archive: ReplayArchiveV2): ReplayArchiveV3 {
  return {
    ...structuredClone(archive),
    version: 3,
    origin: { ...structuredClone(archive.origin), version: 3 },
    inputs: archive.inputs.map((input) => ({
      ...structuredClone(input),
      tick: input.kind === 'turns.set' ? null : 10000,
    })),
    afterEnd: archive.afterEnd.map((input) => ({
      ...structuredClone(input),
      tick: input.kind === 'turns.set' ? null : 999999,
    })),
  };
}

export function exportDatabase(archive: ReplayArchiveV2 | ReplayArchiveV3) {
  const end = archive.end;
  const tx = {
    world: { findUniqueOrThrow: vi.fn(async () => ({ replayOrigin: archive.origin, ...archive.config })) },
    worldResult: {
      findUnique: vi.fn(async () =>
        end
          ? { ...end, endedSequence: end.sequence, endedTick: end.tick, endedYear: end.year, endedMonth: end.month }
          : null,
      ),
    },
    yearbookSnapshot: { findMany: vi.fn(async () => archive.months) },
    inputEvent: { findMany: vi.fn(async () => [...archive.inputs, ...archive.afterEnd]) },
  };
  return {
    tx,
    db: { $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaClient,
  };
}
