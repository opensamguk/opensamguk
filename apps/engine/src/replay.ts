import type { PrismaClient } from '@opensamguk/db';
import {
  applyRecordedInput,
  initialReplayState,
  nextGameAction,
  runReplayAction,
  TICKS_PER_MONTH,
  type RecordedInput,
  type WorldInit,
  type Yearbook,
  buildYearbook,
  monthlyDate,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';

export interface ReplayOrigin {
  version: 1;
  initial: WorldInit;
  initialStateHash: string;
  resourceHash: string;
}
export interface ReplayArchive {
  version: 1;
  origin: ReplayOrigin;
  inputs: RecordedInput[];
  months: { tick: number; year: number; month: number; sequence: number; stateHash: string; data: Yearbook }[];
}
export function resourceHash(initial: WorldInit) {
  return hashState({
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
  });
}

export async function exportReplay(db: PrismaClient, worldId: string): Promise<ReplayArchive> {
  return db.$transaction(
    async (tx) => {
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      if (world.replayOrigin === null) throw new Error('생성 기록이 없는 월드는 재생할 수 없습니다.');
      const months = await tx.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
      const lastSequence = months.at(-1)?.sequence ?? 0;
      const events = await tx.inputEvent.findMany({
        where: { worldId, sequence: { lte: lastSequence } },
        orderBy: { sequence: 'asc' },
      });
      return {
        version: 1,
        origin: world.replayOrigin as unknown as ReplayOrigin,
        inputs: events.map((event) => {
          if (event.status === 'PENDING' || event.sequence === null) throw new Error('완료되지 않은 입력 기록입니다.');
          return {
            sequence: event.sequence,
            generalId: event.generalId,
            kind: event.kind,
            status: event.status,
            payload: event.payload,
            result: event.result,
          };
        }),
        months: months.map(({ tick, year, month, sequence, stateHash, data }) => ({
          tick,
          year,
          month,
          sequence,
          stateHash,
          data: data as unknown as Yearbook,
        })),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export function replayArchive(value: unknown, months = 12): { tick: number; stateHash: string }[] {
  const archive = value as ReplayArchive;
  if (
    !Number.isSafeInteger(months) ||
    months < 1 ||
    months > 12000 ||
    archive?.version !== 1 ||
    archive.origin?.version !== 1 ||
    !Array.isArray(archive.months) ||
    !Array.isArray(archive.inputs)
  ) {
    throw new Error('재생 기록 형식과 개월 수를 확인하세요.');
  }
  const { origin } = archive;
  if (origin.initialStateHash !== hashState(origin.initial) || origin.resourceHash !== resourceHash(origin.initial)) {
    throw new Error('월드 생성 기록 또는 리소스 해시가 다릅니다.');
  }
  if (archive.months.length < months) throw new Error('비교할 월간 기록이 부족합니다.');
  const inputs = new Map<number, RecordedInput>();
  let previous = 0;
  for (const input of archive.inputs) {
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence <= previous ||
      !['APPLIED', 'REJECTED'].includes(input.status)
    )
      throw new Error('입력 기록의 순서·상태가 올바르지 않습니다.');
    previous = input.sequence;
    inputs.set(input.sequence, input);
  }
  let replay = initialReplayState(origin.initial);
  let sequence = 0;
  const hashes: { tick: number; stateHash: string }[] = [];
  for (let i = 0; i < months; i++) {
    const expected = archive.months[i]!;
    const tick = (i + 1) * TICKS_PER_MONTH;
    const date = monthlyDate(replay.state.startYear, tick);
    if (
      expected.tick !== tick ||
      expected.year !== date.year ||
      expected.month !== date.month ||
      !Number.isSafeInteger(expected.sequence) ||
      expected.sequence <= sequence ||
      expected.sequence > 10_000_000
    ) {
      throw new Error('월간 기록의 경계·연월·순서가 올바르지 않습니다.');
    }
    while (sequence < expected.sequence) {
      const input = inputs.get(++sequence);
      if (input) replay = applyRecordedInput(replay, input);
      else {
        const action = nextGameAction(replay);
        if (action.tick > tick || (action.kind === 'monthly' && sequence !== expected.sequence)) {
          throw new Error(`정산 순서가 다릅니다: ${tick}`);
        }
        replay = runReplayAction(replay, origin.initial.seed);
      }
    }
    const stateHash = hashState(replay);
    if (
      replay.monthlyTick !== tick ||
      stateHash !== expected.stateHash ||
      hashState(buildYearbook(replay.state, date.year)) !== hashState(expected.data)
    ) {
      throw new Error(`재생 해시가 다릅니다: ${tick}`);
    }
    hashes.push({ tick, stateHash });
  }
  return hashes;
}
