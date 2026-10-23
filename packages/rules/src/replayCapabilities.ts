import { z } from 'zod';
import { TREATY_INPUTS, applyTreatyInput, settleTreaties, validateTreatyRecord } from './diplomacy/treaty';
import { isPolicyMode } from './policy';
import {
  enableReplayPolicy,
  policyFormatSchema,
  policyMarkerPayloadSchema,
  policyMarkerResultSchema,
  validatePolicyRecordedInput,
  type PolicyFormat,
} from './policy/replay';
import {
  applyRecordedInput,
  initialReplayState,
  nextGameAction,
  runReplayAction,
  type RecordedInput,
  type ReplayState,
} from './replay';
import type { WorldInit } from './world/bootstrap';
import type { UnitSetResource } from './world/resources';

export const ORIGIN_CAPS = 6 as const;
export const ARCHIVE_CAPS = 6 as const;

export interface CapabilityDescriptor {
  version: 1;
  treaty?: { version: 1 };
  ext?: Record<string, unknown>;
  personnel?: Record<string, unknown>;
}
export interface CapsOrigin {
  version: typeof ORIGIN_CAPS;
  initial: WorldInit;
  initialStateHash: string;
  resourceHash: string;
  capabilities: CapabilityDescriptor;
}
export interface CapabilitySelection {
  treaty: { version: 1 };
  policy: PolicyFormat | null;
}
type CapsOwner = 'common' | 'policy' | 'treaty';
export const CAPS_INPUT_OWNERS: Readonly<Record<string, CapsOwner>> = Object.freeze({
  'turns.set': 'common',
  'general.create': 'common',
  'general.setPolicy': 'policy',
  'general.active': 'policy',
  'system.policy.enable': 'policy',
  ...Object.fromEntries(Object.keys(TREATY_INPUTS).map((kind) => [kind, 'treaty' as const])),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
const plainObject = z.custom<Record<string, unknown>>(isPlainObject);
const treatyDescriptor = z.strictObject({ version: z.literal(1) });
const descriptorSchema = z
  .strictObject({
    version: z.literal(1),
    treaty: treatyDescriptor.optional(),
    ext: plainObject.optional(),
    personnel: plainObject.optional(),
  })
  .refine((value) => ['treaty', 'ext', 'personnel'].some((key) => Object.hasOwn(value, key)));
const initialSchema = z.custom<WorldInit>((value) => isPlainObject(value) && !Object.hasOwn(value, 'treaties'));
const originSchema = z.strictObject({
  version: z.literal(ORIGIN_CAPS),
  initial: initialSchema,
  initialStateHash: z.string(),
  resourceHash: z.string(),
  capabilities: descriptorSchema,
});
const selectionSchema = z.strictObject({ treaty: treatyDescriptor, policy: policyFormatSchema.nullable() });
const sequenceSchema = z.number().int().min(1).max(2_147_483_647);

// 해시를 대조하는 앱 adapter가 전체 initial과 archive 외피를 검사한다.
export function parseCapsOrigin(value: unknown): CapsOrigin {
  if (!isPlainObject(value) || !isPlainObject(value.capabilities)) throw new Error('형식 6 생성 기록을 확인하세요.');
  for (const key of ['treaty', 'ext', 'personnel'])
    if (Object.hasOwn(value.capabilities, key) && !isPlainObject(value.capabilities[key]))
      throw new Error('형식 6 기능 표시를 확인하세요.');
  originSchema.parse(value);
  return structuredClone(value) as unknown as CapsOrigin;
}

function assertTreatyOnly(origin: CapsOrigin): void {
  const descriptor = origin.capabilities;
  if (Object.hasOwn(descriptor, 'ext') || Object.hasOwn(descriptor, 'personnel') || !descriptor.treaty)
    throw new Error('아직 재생할 수 없는 기능 조합입니다.');
}

export function selectSupportedCapabilities(origin: CapsOrigin, config: unknown): CapabilitySelection {
  const parsed = parseCapsOrigin(origin);
  assertTreatyOnly(parsed);
  const options = z
    .strictObject({
      endYear: z.number().int().min(parsed.initial.startYear).max(10000).nullable(),
      outcomeFromSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      policy: policyFormatSchema.optional(),
    })
    .parse(config);
  return { treaty: { version: 1 }, policy: options.policy ?? null };
}

export function capsResourceHashInput(origin: CapsOrigin): Readonly<Record<string, unknown>> {
  const { initial, capabilities } = parseCapsOrigin(origin);
  return {
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    capabilities,
  };
}

export function validateCapsRecordedInput(
  value: unknown,
  ctx: { selection: CapabilitySelection; monthlyTick: number; endTick?: number },
): RecordedInput {
  const selection = selectionSchema.parse(ctx.selection);
  if (!isPlainObject(value) || typeof value.kind !== 'string' || !Object.hasOwn(CAPS_INPUT_OWNERS, value.kind))
    throw new Error('형식 6 입력 종류를 확인하세요.');
  const sequence = sequenceSchema.parse(value.sequence);
  const owner = CAPS_INPUT_OWNERS[value.kind]!;
  const modern =
    selection.policy !== null &&
    isPolicyMode({ fromSequence: selection.policy.fromSequence, actionSequence: sequence });
  if (owner === 'policy' && !modern) throw new Error('전환 전 방침 입력입니다.');
  if (
    value.kind === 'system.policy.enable' &&
    (!selection.policy || selection.policy.fromSequence === 0 || sequence !== selection.policy.fromSequence)
  )
    throw new Error('방침 전환 표지의 순서를 확인하세요.');
  let input: RecordedInput;
  if (owner === 'treaty') {
    input = validateTreatyRecord(value, {
      treaty: selection.treaty,
      monthlyTick: ctx.monthlyTick,
      ...(ctx.endTick === undefined ? {} : { endTick: ctx.endTick }),
    });
  } else {
    validatePolicyRecordedInput(value, modern);
    input = structuredClone(value);
  }
  if (ctx.endTick !== undefined && input.status !== 'REJECTED') throw new Error('종료 뒤 적용된 입력 기록입니다.');
  return input;
}

export function startCapsReplay(origin: CapsOrigin, selection: CapabilitySelection): ReplayState {
  const parsed = parseCapsOrigin(origin);
  assertTreatyOnly(parsed);
  const selected = selectionSchema.parse(selection);
  const replay = initialReplayState(parsed.initial);
  return selected.policy?.fromSequence === 0 ? enableReplayPolicy(replay, selected.policy.turnTermMinutes, 0) : replay;
}

export function enterCapsPolicyAtMarker(
  replay: ReplayState,
  value: unknown,
  selection: CapabilitySelection,
): ReplayState {
  const input = validateCapsRecordedInput(value, { selection, monthlyTick: replay.monthlyTick });
  if (input.kind !== 'system.policy.enable' || replay.policy || !selection.policy)
    throw new Error('방침 전환 표지를 확인하세요.');
  const payload = policyMarkerPayloadSchema.parse(input.payload);
  const result = policyMarkerResultSchema.parse(input.result);
  const hasHuman = Object.values(replay.state.generals).some((general) => general.userId !== null);
  if (
    result.fromSequence !== selection.policy.fromSequence ||
    result.turnTermMinutes !== selection.policy.turnTermMinutes ||
    JSON.stringify(payload.emptySlots) !== JSON.stringify(result.emptySlots) ||
    hasHuman !== (result.baselineActiveTick !== null)
  )
    throw new Error('방침 전환 표지의 설정이나 활동 기준이 다릅니다.');
  return enableReplayPolicy(replay, result.turnTermMinutes, result.baselineActiveTick, result.emptySlots);
}

export function applyCapsRecordedInput(
  replay: ReplayState,
  value: unknown,
  ctx: { selection: CapabilitySelection; endTick?: number },
): ReplayState {
  const input = validateCapsRecordedInput(value, { ...ctx, monthlyTick: replay.monthlyTick });
  if (input.status === 'REJECTED') return replay;
  if (input.kind === 'system.policy.enable') return enterCapsPolicyAtMarker(replay, input, ctx.selection);
  if (CAPS_INPUT_OWNERS[input.kind] !== 'treaty') return applyRecordedInput(replay, input);
  const record = validateTreatyRecord(input, {
    treaty: ctx.selection.treaty,
    monthlyTick: replay.monthlyTick,
    ...(ctx.endTick === undefined ? {} : { endTick: ctx.endTick }),
  });
  const result = applyTreatyInput(replay.state, record, { tick: record.result.tick, sequence: record.sequence });
  if (!result.ok) throw new Error('조약 적용 기록을 재현하지 못했습니다.');
  const recomputed = validateTreatyRecord(
    { ...record, result: result.result },
    {
      treaty: ctx.selection.treaty,
      monthlyTick: replay.monthlyTick,
      ...(ctx.endTick === undefined ? {} : { endTick: ctx.endTick }),
    },
  );
  if (JSON.stringify(record.result) !== JSON.stringify(recomputed.result))
    throw new Error('조약 적용 결과가 기록과 다릅니다.');
  return { ...replay, state: result.state };
}

export function runCapsReplayAction(
  replay: ReplayState,
  seed: string,
  unitSet: UnitSetResource | undefined,
  selection: CapabilitySelection,
): ReplayState {
  selectionSchema.parse(selection);
  const action = nextGameAction(replay);
  const next = runReplayAction(replay, seed, unitSet);
  return action.kind === 'monthly' ? { ...next, state: settleTreaties(next.state, action.tick) } : next;
}
