// D-104: 재생 고정물은 전체 규칙의 형식3으로 생성한다. 파일명에 남은 옛 버전은 호출 경로 식별자다.
import type { PrismaClient } from '@opensamguk/db';
import {
  applyRecordedInput,
  buildYearbook,
  emptyQueue,
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
import { storedFixture, storedReaders } from './storedFixture';

export const featureRegistry: RuleRegistry = {
  monthlyOrder: rules.ruleRegistry.monthlyOrder ?? [],
  features: [
    ...rules.ruleRegistry.features,
    ...['test-a', 'test-b', 'test-c', 'test-d'].map((key) => ({
      key,
      requires: key === 'test-c' ? ['test-a'] : [],
      conflicts: key === 'test-d' ? ['test-b'] : [],
      checkOrigin({ data }: { data: rules.JsonValue | undefined }) {
        if (data !== undefined && data !== 'fixture') throw new Error('시험 기능 자료 오류');
      },
      ...(key === 'test-a'
        ? {
            checkArchive({ inputs }: { inputs: readonly RecordedInput[] }) {
              if (inputs.some((input) => JSON.stringify(input.payload).includes('#')))
                throw new Error('시험 금지 문자');
            },
          }
        : {}),
      initReplayState(replay: ReplayState) {
        return { ...replay, [key]: 0 };
      },
    })),
  ],
  inputKinds: [
    ...rules.ruleRegistry.inputKinds,
    ...['test-a', 'test-b', 'test-c', 'test-d'].flatMap((feature) =>
      (['direct', 'queued'] as const).map((route) => ({
        kind: `${feature}.${route}`,
        feature,
        route,
        directTick: route === 'direct',
        apply(replay: ReplayState, input: RecordedInput) {
          if (typeof (input.payload as { value: unknown }).value !== 'number') throw new Error('fixture value');
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

  const origin: ReplayOriginV3 = {
    version: 3,
    initial,
    initialStateHash: hashState(initial),
    resourceHash: '',
    featureData: rules.providedRuleData(initial, 60),
  };
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
  let replay = rules.initialReplayStateWithRegistry(initial, featureRegistry, origin.featureData);
  let sequence = 0;
  for (let month = 0; month < 12; month++) {
    const core: RecordedInput & { tick: null } = {
      sequence: ++sequence,
      generalId: initial.generals[0]!.id,
      kind: 'turns.set',
      status: 'APPLIED',
      tick: null,
      payload: { turns: emptyQueue(), revision: replay.revisions[initial.generals[0]!.id] },
      result: { revision: replay.revisions[initial.generals[0]!.id]! + 1, activeTick: replay.monthlyTick },
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
          tick: replay.monthlyTick + 10,
          payload: { value: 1 },
          result: {},
        };
        replay = applyRecordedInput(replay, input, featureRegistry);
        archive.inputs.push(input);
      }
    while (replay.monthlyTick === month * 10000) {
      const action = nextGameAction(replay);
      sequence++;
      replay = runReplayAction(replay, initial.seed, initial.unitSet, undefined, featureRegistry);
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

export function asV3(archive: ReplayArchiveV2 | ReplayArchiveV3): ReplayArchiveV3 {
  return {
    ...structuredClone(archive),
    version: 3,
    origin: {
      ...structuredClone(archive.origin),
      version: 3,
      featureData: rules.providedRuleData(archive.origin.initial, 60),
    },
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
  const stored = storedFixture(archive.origin.initial);
  const end = archive.end;
  const tx = {
    ...storedReaders(archive.origin.initial, 'baseline'),
    world: {
      findUniqueOrThrow: async () => ({
        ...stored.world,
        id: 'baseline',
        startYear: archive.origin.initial.startYear,
        seed: archive.origin.initial.seed,
        replayOrigin: archive.origin,
        replayFormat: archive.version === 3 ? 3 : 1,

        treatyFormat: null,
        personnelFormat: null,
        policyFromSequence: null,
        actionSequence: archive.end?.sequence ?? archive.months.at(-1)?.sequence ?? 0,
        turnTermMinutes: 60,
        ...archive.config,
      }),
    },
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

// 기존 호출자 이름을 유지하되 실제 PostgreSQL의 생성·입력·종료·수출은 현재 형식3을 사용한다.
export async function generateReplayV2EngineArchive(
  db: PrismaClient,
  saveWorld: typeof saveInitialWorld = saveInitialWorld,
): Promise<ReplayArchiveV3> {
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
          payload: {
            name: '기준장수',
            leadership: 55,
            strength: 55,
            intel: 55,
            politics: 55,
            charm: 55,
            sex: 'MALE',
            portraitId: null,
          },
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
    if (archive.version !== 3) throw new Error('기준 월드는 archive 2여야 합니다.');
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
