// replay-v2-53dd348.json은 53dd348 엔진과 실제 PostgreSQL에서 사용자 생성 → saveInitialWorld → controlClock start → acquireLease → 입력·연감·worldResult 삽입 → exportReplay 순서로 만들었다.
import type { PrismaClient } from '@opensamguk/db';
import {
  applyRecordedInput,
  buildYearbook,
  emptyTurns,
  monthlyDate,
  nextGameAction,
  runReplayAction,
  type RecordedInput,
  type ReplayOriginV3,
  type ReplayState,
  type RuleRegistry,
} from '@opensamguk/rules';
import * as rules from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import * as replayModule from '../src/replay';
import type { ReplayArchiveV2, ReplayArchiveV3 } from '../src/replay';
import { saveInitialWorld } from '../src/world/persistence';
import { controlClock } from '../src/world/clock';
import { acquireLease, releaseLease, renewLease, type Lease } from '../src/lease';
import { TurnLoop } from '../src/turnLoop';
import { recordTestTurns } from './seasonFixture';
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
    ...(rules.ruleRegistry?.inputKinds ?? []),
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
  origin.resourceHash = replayModule.resourceHashV3(origin);
  const archive: ReplayArchiveV3 = {
    version: 3,
    origin,
    config: { endYear: null, outcomeFromSequence: 0 },
    inputs: [],
    months: [],
    end: null,
    afterEnd: [],
  };
  let replay = rules.initialReplayStateWithRegistry(initial, featureRegistry);
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
    world: { findUniqueOrThrow: async () => ({ replayOrigin: archive.origin, ...archive.config }) },
    worldResult: {
      findUnique: async () =>
        end
          ? { ...end, endedSequence: end.sequence, endedTick: end.tick, endedYear: end.year, endedMonth: end.month }
          : null,
    },
    yearbookSnapshot: { findMany: async () => archive.months },
    inputEvent: { findMany: async () => [...archive.inputs, ...archive.afterEnd] },
  };
  return {
    tx,
    db: { $transaction: async (callback: (tx: unknown) => unknown) => callback(tx) } as unknown as PrismaClient,
  };
}

// 조율 세션이 53dd348 엔진과 실제 PostgreSQL에서 이 함수를 실행해 replay-v2-engine-53dd348.json을 JSON.stringify(결과) 그대로 저장한다.
// 생성 함수는 변경 전 API만 쓴다. 새 엔진 시험은 saveWorld에 형식 1 생성 함수를 전달한다.
export async function generateReplayV2EngineArchive(
  db: PrismaClient,
  saveWorld: typeof saveInitialWorld = saveInitialWorld,
): Promise<ReplayArchiveV2> {
  const userId = 't226-engine-v2-actor';
  let ownsUser = false;
  let worldId: string | undefined;
  let lease: Lease | null = null;
  try {
    await db.user.create({ data: { id: userId, email: userId + '@example.invalid', passwordHash: 'test-only' } });
    ownsUser = true;
    const initial = await monthlyFixture();
    initial.seed = 't2-26-engine-v2';
    initial.generals = [];
    ({ worldId } = await saveWorld(db, initial, {
      name: '형식 1 엔진 기준',
      turnTermMinutes: 60,
      endYear: initial.startYear,
    }));
    await controlClock(db, worldId, 'start');
    lease = await acquireLease(db, worldId, undefined, 120000);
    if (!lease) throw new Error('기준 월드 실행권이 없습니다.');
    const loop = new TurnLoop(db, lease);
    const enqueue = async (key: string) =>
      db.inputEvent.create({
        data: {
          worldId: worldId!,
          userId,
          kind: 'general.create',
          idempotencyKey: key,
          payload: { name: '기준장수', leadership: 55, strength: 55, intel: 55, portraitId: null },
        },
      });
    await enqueue('create');
    await loop.advanceTo(0);
    await recordTestTurns(db, worldId, 1, 'rest');
    await enqueue('duplicate');
    // 밀린 월 경계에서도 형식 1은 입력을 먼저 처리한다.
    await loop.advanceTo(10050);
    for (let month = 2; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10000);
    }
    await enqueue('after-end');
    await loop.advanceTo(120000);
    const archive = await replayModule.exportReplay(db, worldId);
    if (archive.version !== 2) throw new Error('기준 월드는 archive 2여야 합니다.');
    return archive;
  } finally {
    try {
      if (lease) await releaseLease(db, lease);
    } finally {
      try {
        if (worldId) await db.world.delete({ where: { id: worldId } });
      } finally {
        if (ownsUser) await db.user.delete({ where: { id: userId } });
      }
    }
  }
}
