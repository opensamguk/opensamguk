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
  seasonOutcome,
  toGameDate,
  type ReplayState,
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
export interface ReplayEnd {
  sequence: number;
  tick: number;
  reason: 'UNIFIED' | 'END_YEAR';
  winnerNationId: number | null;
  year: number;
  month: number;
  finalStateHash: string;
}
export interface ReplayArchiveV2 {
  version: 2;
  origin: ReplayOrigin;
  config: { endYear: number | null; outcomeFromSequence: number };
  inputs: RecordedInput[];
  months: ReplayArchive['months'];
  end: ReplayEnd | null;
  afterEnd: RecordedInput[];
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

export async function exportReplay(db: PrismaClient, worldId: string): Promise<ReplayArchiveV2> {
  return db.$transaction(
    async (tx) => {
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      if (world.replayOrigin === null) throw new Error('생성 기록이 없는 월드는 재생할 수 없습니다.');
      const months = await tx.yearbookSnapshot.findMany({ where: { worldId }, orderBy: { tick: 'asc' } });
      const result = await tx.worldResult.findUnique({ where: { worldId } });
      const lastSequence = result?.endedSequence ?? months.at(-1)?.sequence ?? 0;
      const events = await tx.inputEvent.findMany({
        where: { worldId, sequence: result ? { not: null } : { lte: lastSequence } },
        orderBy: { sequence: 'asc' },
      });
      const inputs: RecordedInput[] = [];
      const afterEnd: RecordedInput[] = [];
      for (const event of events) {
        if (event.status === 'PENDING' || event.sequence === null) throw new Error('완료되지 않은 입력 기록입니다.');
        const input: RecordedInput = {
          sequence: event.sequence,
          generalId: event.generalId,
          kind: event.kind,
          status: event.status,
          payload: event.payload,
          result: event.result,
        };
        if (input.sequence <= lastSequence) inputs.push(input);
        else {
          if (input.status !== 'REJECTED') throw new Error('종료 뒤 적용된 입력 기록이 있습니다.');
          afterEnd.push(input);
        }
      }
      return {
        version: 2,
        origin: world.replayOrigin as unknown as ReplayOrigin,
        config: { endYear: world.endYear, outcomeFromSequence: world.outcomeFromSequence },
        inputs,
        months: months.map(({ tick, year, month, sequence, stateHash, data }) => ({
          tick,
          year,
          month,
          sequence,
          stateHash,
          data: data as unknown as Yearbook,
        })),
        end: result
          ? {
              sequence: result.endedSequence,
              tick: result.endedTick,
              reason: result.reason,
              winnerNationId: result.winnerNationId,
              year: result.endedYear,
              month: result.endedMonth,
              finalStateHash: result.finalStateHash,
            }
          : null,
        afterEnd,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

function readArchive(value: unknown): ReplayArchive | ReplayArchiveV2 {
  const archive = value as ReplayArchive | ReplayArchiveV2;
  if (
    !archive ||
    ![1, 2].includes(archive.version) ||
    archive.origin?.version !== 1 ||
    !Array.isArray(archive.months) ||
    !Array.isArray(archive.inputs) ||
    ['config', 'end', 'afterEnd'].some((key) => Object.hasOwn(archive, key) !== (archive.version === 2))
  ) {
    throw new Error('재생 기록 형식과 버전을 확인하세요.');
  }
  const { origin } = archive;
  if (origin.initialStateHash !== hashState(origin.initial) || origin.resourceHash !== resourceHash(origin.initial)) {
    throw new Error('월드 생성 기록 또는 리소스 해시가 다릅니다.');
  }
  if (archive.version === 2) {
    const { config, end, afterEnd } = archive;
    if (
      !config ||
      !Object.hasOwn(config, 'endYear') ||
      (config.endYear !== null &&
        (!Number.isSafeInteger(config.endYear) ||
          config.endYear < origin.initial.startYear ||
          config.endYear > 10000)) ||
      !Number.isSafeInteger(config.outcomeFromSequence) ||
      config.outcomeFromSequence < 0 ||
      !Array.isArray(afterEnd) ||
      (end !== null &&
        (!end ||
          !Number.isSafeInteger(end.sequence) ||
          end.sequence < 1 ||
          !Number.isSafeInteger(end.tick) ||
          end.tick < 0 ||
          !['UNIFIED', 'END_YEAR'].includes(end.reason) ||
          (end.reason === 'UNIFIED'
            ? !Number.isSafeInteger(end.winnerNationId) || end.winnerNationId! < 1
            : end.winnerNationId !== null) ||
          !Number.isSafeInteger(end.year) ||
          !Number.isSafeInteger(end.month) ||
          end.month < 1 ||
          end.month > 12 ||
          typeof end.finalStateHash !== 'string'))
    ) {
      throw new Error('재생 설정 또는 종료 기록이 올바르지 않습니다.');
    }
    let previous = end?.sequence ?? 0;
    for (const input of afterEnd) {
      if (
        !end ||
        !input ||
        !Number.isSafeInteger(input.sequence) ||
        input.sequence <= previous ||
        input.status !== 'REJECTED'
      ) {
        throw new Error('종료 뒤 입력의 순서·상태가 올바르지 않습니다.');
      }
      previous = input.sequence;
    }
  }
  let previous = 0;
  for (const input of archive.inputs) {
    if (
      !input ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence <= previous ||
      !['APPLIED', 'REJECTED'].includes(input.status) ||
      (archive.version === 2 && input.sequence > (archive.end?.sequence ?? archive.months.at(-1)?.sequence ?? 0))
    )
      throw new Error('입력 기록의 순서·상태가 올바르지 않습니다.');
    previous = input.sequence;
  }
  return archive;
}

function validSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= 10_000_000;
}

function checkOutcome(
  archive: ReplayArchiveV2,
  replay: ReplayState,
  sequence: number,
  action: ReturnType<typeof nextGameAction>,
): void {
  const date =
    action.kind === 'monthly'
      ? monthlyDate(replay.state.startYear, action.tick)
      : toGameDate(replay.state.startYear, action.tick);
  const outcome =
    sequence > archive.config.outcomeFromSequence
      ? seasonOutcome(replay.state, {
          endYear: archive.config.endYear,
          ...(action.kind === 'monthly' ? { settled: date } : {}),
        })
      : null;
  const end = archive.end;
  if (!end || sequence < end.sequence) {
    if (outcome) throw new Error(`종료 기록보다 먼저 끝났습니다: ${sequence}`);
    return;
  }
  if (
    sequence !== end.sequence ||
    !outcome ||
    outcome.reason !== end.reason ||
    outcome.winnerNationId !== end.winnerNationId ||
    action.tick !== end.tick ||
    (end.reason === 'END_YEAR' && action.kind !== 'monthly') ||
    date.year !== end.year ||
    date.month !== end.month ||
    hashState(replay) !== end.finalStateHash
  ) {
    throw new Error('종료 사건의 tick·사유·승자·연월·해시가 다릅니다.');
  }
}

function checkMonthBoundary(
  expected: ReplayArchive['months'][number] | undefined,
  replay: ReplayState,
  tick: number,
  previousSequence: number,
): asserts expected is ReplayArchive['months'][number] {
  const date = monthlyDate(replay.state.startYear, tick);
  if (
    !expected ||
    expected.tick !== tick ||
    expected.year !== date.year ||
    expected.month !== date.month ||
    !validSequence(expected.sequence) ||
    expected.sequence <= previousSequence
  ) {
    throw new Error('월간 기록의 경계·연월·순서가 올바르지 않습니다.');
  }
}

function checkMonth(replay: ReplayState, expected: ReplayArchive['months'][number]): string {
  const stateHash = hashState(replay);
  if (
    replay.monthlyTick !== expected.tick ||
    stateHash !== expected.stateHash ||
    hashState(buildYearbook(replay.state, expected.year)) !== hashState(expected.data)
  ) {
    throw new Error(`재생 해시가 다릅니다: ${expected.tick}`);
  }
  return stateHash;
}

export function replayArchive(value: unknown, months = 12): { tick: number; stateHash: string }[] {
  if (!Number.isSafeInteger(months) || months < 1 || months > 12000) {
    throw new Error('재생 개월 수를 확인하세요.');
  }
  const archive = readArchive(value);
  if (archive.months.length < months) throw new Error('비교할 월간 기록이 부족합니다.');
  const { origin } = archive;
  const inputs = new Map(archive.inputs.map((input) => [input.sequence, input]));
  let replay = initialReplayState(origin.initial);
  let sequence = 0;
  const hashes: { tick: number; stateHash: string }[] = [];
  for (let i = 0; i < months; i++) {
    const expected = archive.months[i]!;
    const tick = (i + 1) * TICKS_PER_MONTH;
    checkMonthBoundary(expected, replay, tick, sequence);
    if (archive.version === 2 && archive.end && expected.sequence > archive.end.sequence) {
      throw new Error('종료 뒤 월간 기록이 있습니다.');
    }
    while (sequence < expected.sequence) {
      const input = inputs.get(++sequence);
      if (input) replay = applyRecordedInput(replay, input);
      else {
        const action = nextGameAction(replay);
        if (action.tick > tick || (action.kind === 'monthly' && sequence !== expected.sequence)) {
          throw new Error(`정산 순서가 다릅니다: ${tick}`);
        }
        replay = runReplayAction(replay, origin.initial.seed, origin.initial.unitSet);
        if (archive.version === 2) checkOutcome(archive, replay, sequence, action);
      }
    }
    const stateHash = checkMonth(replay, expected);
    hashes.push({ tick, stateHash });
  }
  return hashes;
}

export function replayToEnd(value: unknown): ReplayEnd {
  const archive = readArchive(value);
  if (archive.version !== 2 || !archive.end) throw new Error('종료 기록이 있는 v2 보관 파일이 필요합니다.');
  const { origin, end } = archive;
  const inputs = new Map(archive.inputs.map((input) => [input.sequence, input]));
  let replay = initialReplayState(origin.initial);
  let monthIndex = 0;
  for (let sequence = 1; sequence <= end.sequence; sequence++) {
    const input = inputs.get(sequence);
    if (input) {
      if (sequence === end.sequence) throw new Error('종료 번호에 게임 사건이 없습니다.');
      replay = applyRecordedInput(replay, input);
      continue;
    }
    const action = nextGameAction(replay);
    if (action.kind === 'monthly') {
      const expected = archive.months[monthIndex];
      checkMonthBoundary(expected, replay, (monthIndex + 1) * TICKS_PER_MONTH, sequence - 1);
      if (expected.sequence !== sequence) throw new Error(`정산 순서가 다릅니다: ${action.tick}`);
    }
    replay = runReplayAction(replay, origin.initial.seed, origin.initial.unitSet);
    if (action.kind === 'monthly') checkMonth(replay, archive.months[monthIndex++]!);
    checkOutcome(archive, replay, sequence, action);
  }
  if (monthIndex !== archive.months.length) throw new Error('종료 뒤 월간 기록이 있습니다.');
  return { ...end, finalStateHash: hashState(replay) };
}
