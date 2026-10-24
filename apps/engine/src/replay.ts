import type { PrismaClient } from '@opensamguk/db';
import {
  applyRecordedInput,
  initialReplayState,
  initialReplayStateWithRegistry,
  checkReplayOrigin,
  ruleRegistry,
  type RuleRegistry,
  type ReplayOriginV3,
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
  assertReplayPolicy,
  enableReplayPolicy,
  isPolicyMode,
  policyFormatSchema,
  policyMarkerPayloadSchema,
  policyMarkerResultSchema,
  validatePolicyRecordedInput,
  type PolicyFormat,
  selectWorldCapabilities,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { exportCapsArchive, replayCapsArchive, replayCapsToEnd, type CapsArchive } from './replayCaps';
import { checkStoredReplayFormat } from './features';

export type { ReplayOriginV3 } from '@opensamguk/rules';

const MAX_ACTION_SEQUENCE = 2_147_483_647;

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
export interface ReplayArchiveV5 extends Omit<ReplayArchiveV2, 'version' | 'config'> {
  version: 5;
  config: ReplayArchiveV2['config'] & { policy: PolicyFormat };
}
export interface ReplayArchiveV3 extends Omit<ReplayArchiveV2, 'version' | 'origin' | 'inputs' | 'afterEnd'> {
  version: 3;
  origin: ReplayOriginV3;
  inputs: (RecordedInput & { tick: number | null })[];
  afterEnd: (RecordedInput & { tick: number | null })[];
}
type Archive = ReplayArchive | ReplayArchiveV2 | ReplayArchiveV3 | ReplayArchiveV5;
export function resourceHash(initial: WorldInit) {
  return hashState({
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
  });
}

export function resourceHashV3(origin: ReplayOriginV3) {
  if (!origin.featureData) return resourceHash(origin.initial);
  const initial = origin.initial;
  return hashState({
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    featureData: origin.featureData,
  });
}

export async function exportReplay(
  db: PrismaClient,
  worldId: string,
): Promise<ReplayArchiveV2 | ReplayArchiveV3 | ReplayArchiveV5 | CapsArchive> {
  return db.$transaction(
    async (tx) => {
      const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
      if (world.replayOrigin === null) throw new Error('생성 기록이 없는 월드는 재생할 수 없습니다.');
      checkStoredReplayFormat(world);
      const v3 = world.replayFormat === 3;
      if (!v3) {
        const capabilities = selectWorldCapabilities(world);
        if (capabilities.kind === 'caps') return exportCapsArchive(tx, world, capabilities);
      } else checkReplayOrigin(world.replayOrigin);
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
          ...(v3 ? { tick: event.tick } : {}),
        };
        if (input.sequence <= lastSequence) inputs.push(input);
        else {
          if (input.status !== 'REJECTED') throw new Error('종료 뒤 적용된 입력 기록이 있습니다.');
          afterEnd.push(input);
        }
      }
      const common = {
        origin: world.replayOrigin as unknown as ReplayOrigin,
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
      const config = { endYear: world.endYear, outcomeFromSequence: world.outcomeFromSequence };
      if (v3) {
        const archive = { ...common, version: 3, config };
        readArchive(archive);
        return archive as unknown as ReplayArchiveV3;
      }
      if (world.policyFromSequence != null) {
        if (!isPolicyMode({ fromSequence: world.policyFromSequence, actionSequence: world.actionSequence }))
          throw new Error('방침 전환 순서가 올바르지 않습니다.');
        return {
          ...common,
          version: 5 as const,
          config: {
            ...config,
            policy: {
              version: 1 as const,
              fromSequence: world.policyFromSequence,
              turnTermMinutes: world.turnTermMinutes,
            },
          },
        };
      }
      return {
        version: 2 as const,
        origin: common.origin,
        config,
        inputs: common.inputs,
        months: common.months,
        end: common.end,
        afterEnd: common.afterEnd,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

export function readArchive(value: unknown, registry: RuleRegistry = ruleRegistry): Archive {
  const archive = value as Archive;
  if (
    !archive ||
    ![1, 2, 3, 5].includes(archive.version) ||
    archive.origin?.version !== (archive.version === 3 ? 3 : 1) ||
    !Array.isArray(archive.months) ||
    !Array.isArray(archive.inputs) ||
    ['config', 'end', 'afterEnd'].some((key) => Object.hasOwn(archive, key) !== (archive.version !== 1))
  ) {
    throw new Error('재생 기록 형식과 버전을 확인하세요.');
  }
  const { origin } = archive;
  checkReplayOrigin(origin, registry);
  if (
    origin.initialStateHash !== hashState(origin.initial) ||
    origin.resourceHash !== (origin.version === 3 ? resourceHashV3(origin) : resourceHash(origin.initial))
  ) {
    throw new Error('월드 생성 기록 또는 리소스 해시가 다릅니다.');
  }
  if (archive.version !== 1) {
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
          !validSequence(end.sequence, MAX_ACTION_SEQUENCE) ||
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
      (archive.version !== 1 && input.sequence > (archive.end?.sequence ?? archive.months.at(-1)?.sequence ?? 0))
    )
      throw new Error('입력 기록의 순서·상태가 올바르지 않습니다.');
    previous = input.sequence;
  }
  if (archive.version === 5) validatePolicyArchive(archive);
  const allInputs = [...archive.inputs, ...(archive.version !== 1 ? archive.afterEnd : [])];
  for (const input of allInputs) {
    if (archive.version !== 3) {
      if (Object.hasOwn(input, 'tick')) throw new Error('기존 형식 입력에 tick을 넣을 수 없습니다.');
      continue;
    }
    const kind = registry.inputKinds.find((kind) => kind.kind === input.kind);
    if (!kind) throw new Error('등록되지 않은 입력 종류입니다.');
    const numericTick = kind.route === 'queued' || kind.directTick === true;
    if (
      !Object.hasOwn(input, 'tick') ||
      (numericTick
        ? !Number.isSafeInteger(input.tick) || input.tick! < 0 || input.tick! > 2_147_483_647
        : input.tick !== null)
    )
      throw new Error('입력의 처리 tick을 확인하세요.');
    if (kind.feature !== null && !archive.origin.initial.ruleFeatures?.includes(kind.feature)) {
      if (input.status === 'APPLIED') throw new Error('이 월드에서 켜지 않은 기능입니다.');
      const result = input.result as { code?: unknown; message?: unknown } | null;
      if (
        !result ||
        result.code !== 'FEATURE_DISABLED' ||
        typeof result.message !== 'string' ||
        Object.keys(result).some((key) => key !== 'code' && key !== 'message')
      )
        throw new Error('끈 기능의 입력 거절 기록이 다릅니다.');
    }
  }
  if (archive.version === 3)
    for (const key of archive.origin.initial.ruleFeatures ?? [])
      registry.features
        .find((feature) => feature.key === key)!
        .checkArchive?.({
          origin: archive.origin,
          inputs: allInputs.sort((a, b) => a.sequence - b.sequence),
          end: archive.end,
        });
  return archive;
}

function exactKeys(value: object, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validatePolicyArchive(archive: ReplayArchiveV5) {
  if (
    !exactKeys(archive, ['version', 'origin', 'config', 'inputs', 'months', 'end', 'afterEnd']) ||
    !exactKeys(archive.config, ['endYear', 'outcomeFromSequence', 'policy']) ||
    !exactKeys(archive.origin, ['version', 'initial', 'initialStateHash', 'resourceHash'])
  )
    throw new Error('방침 보관 파일의 키가 올바르지 않습니다.');
  const format = policyFormatSchema.parse(archive.config.policy);
  const coverage = archive.end?.sequence ?? archive.months.at(-1)?.sequence ?? 0;
  const markers = archive.inputs.filter((input) => input.kind === 'system.policy.enable');
  if (markers.length !== (format.fromSequence > 0 && format.fromSequence <= coverage ? 1 : 0))
    throw new Error('방침 전환 표지 수가 올바르지 않습니다.');
  for (const input of [...archive.inputs, ...archive.afterEnd]) {
    validatePolicyRecordedInput(
      input,
      isPolicyMode({ fromSequence: format.fromSequence, actionSequence: input.sequence }),
    );
    if (input.kind === 'system.policy.enable') {
      const payload = policyMarkerPayloadSchema.parse(input.payload);
      const result = policyMarkerResultSchema.parse(input.result);
      if (
        input.sequence !== format.fromSequence ||
        input.status !== 'APPLIED' ||
        input.generalId !== null ||
        result.fromSequence !== input.sequence ||
        result.turnTermMinutes !== format.turnTermMinutes ||
        JSON.stringify(payload.emptySlots) !== JSON.stringify(result.emptySlots)
      )
        throw new Error('방침 전환 표지가 설정과 다릅니다.');
    }
  }
}

function startReplay(archive: Archive, registry: RuleRegistry = ruleRegistry) {
  const initial =
    archive.version === 3
      ? initialReplayStateWithRegistry(archive.origin.initial, registry, archive.origin.featureData)
      : initialReplayState(archive.origin.initial);
  return archive.version === 5 && archive.config.policy.fromSequence === 0
    ? enableReplayPolicy(initial, archive.config.policy.turnTermMinutes, 0)
    : initial;
}
function applyArchiveInput(
  archive: Archive,
  replay: ReplayState,
  input: RecordedInput,
  untouched: Set<number>,
  lastActionTick: number,
  registry: RuleRegistry = ruleRegistry,
) {
  if (
    archive.version === 3 &&
    registry.inputKinds.find((kind) => kind.kind === input.kind)!.route === 'queued' &&
    (input.tick! < replay.monthlyTick || input.tick! >= replay.monthlyTick + TICKS_PER_MONTH)
  )
    throw new Error('입력의 처리 tick이 재생 월 창을 벗어났습니다.');
  if (archive.version === 5 && input.sequence === archive.config.policy.fromSequence) {
    if (input.kind !== 'system.policy.enable') throw new Error('방침 전환 순서에 표지가 없습니다.');
    const result = policyMarkerResultSchema.parse(input.result);
    const hasHuman = Object.values(replay.state.generals).some((general) => general.userId !== null);
    if ((hasHuman && result.baselineActiveTick === null) || (!hasHuman && result.baselineActiveTick !== null))
      throw new Error('전환 표지의 사람 장수와 활동 기준이 맞지 않습니다.');
    const expected = [...untouched].filter((id) => replay.state.generals[id]).sort((a, b) => a - b);
    if (
      JSON.stringify(expected) !== JSON.stringify(result.emptySlots) ||
      result.clockTick < lastActionTick ||
      expected.some((id) =>
        replay.turns[id]!.some(
          (turn) =>
            !exactKeys(turn, ['commandKey', 'args']) ||
            turn.commandKey !== 'rest' ||
            JSON.stringify(turn.args) !== '{}',
        ),
      )
    )
      throw new Error('방침 전환 전 칸 집합이나 시계가 다릅니다.');
    return enableReplayPolicy(replay, result.turnTermMinutes, result.baselineActiveTick, result.emptySlots);
  }
  if (input.status === 'APPLIED' && input.kind === 'turns.set' && input.generalId !== null)
    untouched.delete(input.generalId);
  return applyRecordedInput(replay, input, registry);
}

function validSequence(sequence: number, maximum = 10_000_000): boolean {
  return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= maximum;
}

function checkOutcome(
  archive: ReplayArchiveV2 | ReplayArchiveV3 | ReplayArchiveV5,
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
  maximumSequence = 10_000_000,
): asserts expected is ReplayArchive['months'][number] {
  const date = monthlyDate(replay.state.startYear, tick);
  if (
    !expected ||
    expected.tick !== tick ||
    expected.year !== date.year ||
    expected.month !== date.month ||
    !validSequence(expected.sequence, maximumSequence) ||
    expected.sequence <= previousSequence
  ) {
    throw new Error('월간 기록의 경계·연월·순서가 올바르지 않습니다.');
  }
}

function checkMonth(replay: ReplayState, expected: ReplayArchive['months'][number]): string {
  assertReplayPolicy(replay);
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

export function replayArchive(
  value: unknown,
  months = 12,
  registry: RuleRegistry = ruleRegistry,
): { tick: number; stateHash: string }[] {
  if (value !== null && typeof value === 'object' && 'version' in value && value.version === 6)
    return replayCapsArchive(value, months);
  if (!Number.isSafeInteger(months) || months < 1 || months > 12000) {
    throw new Error('재생 개월 수를 확인하세요.');
  }
  const archive = readArchive(value, registry);
  if (archive.months.length < months) throw new Error('비교할 월간 기록이 부족합니다.');
  const { origin } = archive;
  const inputs = new Map(archive.inputs.map((input) => [input.sequence, input]));
  let replay = startReplay(archive, registry);
  const untouched = new Set(origin.initial.generals.map((general) => general.id));
  let lastActionTick = 0;
  let sequence = 0;
  const hashes: { tick: number; stateHash: string }[] = [];
  for (let i = 0; i < months; i++) {
    const expected = archive.months[i]!;
    const tick = (i + 1) * TICKS_PER_MONTH;
    checkMonthBoundary(expected, replay, tick, sequence, archive.version !== 1 ? MAX_ACTION_SEQUENCE : 10_000_000);
    if (archive.version !== 1 && archive.end && expected.sequence > archive.end.sequence) {
      throw new Error('종료 뒤 월간 기록이 있습니다.');
    }
    while (sequence < expected.sequence) {
      const input = inputs.get(++sequence);
      if (input) replay = applyArchiveInput(archive, replay, input, untouched, lastActionTick, registry);
      else {
        if (archive.version === 5 && archive.config.policy.fromSequence === sequence)
          throw new Error('방침 전환 표지가 없습니다.');
        const action = nextGameAction(replay);
        if (action.tick > tick || (action.kind === 'monthly' && sequence !== expected.sequence)) {
          throw new Error(`정산 순서가 다릅니다: ${tick}`);
        }
        replay = runReplayAction(replay, origin.initial.seed, origin.initial.unitSet, undefined, registry);
        lastActionTick = action.tick;
        if (action.kind === 'turn') untouched.delete(action.generalId);
        if (archive.version !== 1) checkOutcome(archive, replay, sequence, action);
      }
    }
    const stateHash = checkMonth(replay, expected);
    hashes.push({ tick, stateHash });
  }
  return hashes;
}

export function replayToEnd(value: unknown, registry: RuleRegistry = ruleRegistry): ReplayEnd {
  if (value !== null && typeof value === 'object' && 'version' in value && value.version === 6)
    return replayCapsToEnd(value);
  const archive = readArchive(value, registry);
  if (archive.version === 1 || !archive.end) throw new Error('종료 기록이 있는 v2 보관 파일이 필요합니다.');
  const { origin, end } = archive;
  const inputs = new Map(archive.inputs.map((input) => [input.sequence, input]));
  let replay = startReplay(archive, registry);
  const untouched = new Set(origin.initial.generals.map((general) => general.id));
  let lastActionTick = 0;
  let monthIndex = 0;
  for (let sequence = 1; sequence <= end.sequence; sequence++) {
    const input = inputs.get(sequence);
    if (input) {
      if (sequence === end.sequence) throw new Error('종료 번호에 게임 사건이 없습니다.');
      replay = applyArchiveInput(archive, replay, input, untouched, lastActionTick, registry);
      continue;
    }
    if (archive.version === 5 && archive.config.policy.fromSequence === sequence)
      throw new Error('방침 전환 표지가 없습니다.');
    const action = nextGameAction(replay);
    if (action.kind === 'monthly') {
      const expected = archive.months[monthIndex];
      checkMonthBoundary(expected, replay, (monthIndex + 1) * TICKS_PER_MONTH, sequence - 1, MAX_ACTION_SEQUENCE);
      if (expected.sequence !== sequence) throw new Error(`정산 순서가 다릅니다: ${action.tick}`);
    }
    replay = runReplayAction(replay, origin.initial.seed, origin.initial.unitSet, undefined, registry);
    lastActionTick = action.tick;
    if (action.kind === 'turn') untouched.delete(action.generalId);
    if (action.kind === 'monthly') checkMonth(replay, archive.months[monthIndex++]!);
    checkOutcome(archive, replay, sequence, action);
  }
  if (monthIndex !== archive.months.length) throw new Error('종료 뒤 월간 기록이 있습니다.');
  return { ...end, finalStateHash: hashState(replay) };
}
