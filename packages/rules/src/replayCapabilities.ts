import { z } from 'zod';
import { createCommandResolver, type EnabledCommands } from './commands/resolve';
import { extSliceKeys } from './commands/ext/state';
import { applyTreatyInput, settleTreaties, validateTreatyRecord } from './diplomacy/treaty';
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
import { parsePreset, presetCommands, presetRules, type WorldPreset } from './world/preset';
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
export interface ExtDescriptorV1 {
  version: 1;
  commands: EnabledCommands;
  preset: WorldPreset;
  resources: Record<string, never>;
  sliceKeys: [];
}
export type CapabilitySelection =
  | { treaty: { version: 1 }; policy: PolicyFormat | null }
  | { ext: ExtDescriptorV1; policy: PolicyFormat & { fromSequence: 0 } };
type CapsOwner = 'common' | 'policy' | 'treaty';
export const CAPS_INPUT_OWNERS: Readonly<Record<string, CapsOwner>> = Object.freeze({
  'turns.set': 'common',
  'general.create': 'common',
  'general.setPolicy': 'policy',
  'general.active': 'policy',
  'system.policy.enable': 'policy',
  'treaty.propose': 'treaty',
  'treaty.respond': 'treaty',
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
function sameCanonical(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((entry, index) => sameCanonical(entry, right[index]));
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left).sort();
  const otherKeys = Object.keys(right).sort();
  return (
    keys.length === otherKeys.length &&
    keys.every((key, index) => key === otherKeys[index] && sameCanonical(left[key], right[key]))
  );
}
const STATELESS_STRATAGEMS = ['fire_attack', 'incite', 'plunder', 'sabotage'] as const;
const extDescriptor = z
  .strictObject({
    version: z.literal(1),
    commands: z.strictObject({ general: z.array(z.enum(STATELESS_STRATAGEMS)).min(1), nation: z.array(z.never()) }),
    preset: plainObject,
    resources: z.strictObject({}),
    sliceKeys: z.array(z.never()),
  })
  .transform((ext, context): ExtDescriptorV1 => {
    try {
      if (ext.commands.general.some((key, index, keys) => index > 0 && keys[index - 1]! >= key))
        throw new Error('확장 명령 순서를 확인하세요.');
      createCommandResolver(ext.commands);
      if (!sameCanonical(extSliceKeys(ext.commands), ext.sliceKeys)) throw new Error('확장 상태 조각이 다릅니다.');
      const preset = parsePreset(ext.preset);
      if (!sameCanonical(preset, ext.preset) || !sameCanonical(presetCommands(preset), ext.commands))
        throw new Error('확장 명령과 프리셋이 다릅니다.');
      return { ...ext, preset, sliceKeys: [] };
    } catch {
      context.addIssue({ code: 'custom', message: '확장 기능의 명령과 프리셋을 확인하세요.' });
      return z.NEVER;
    }
  });
const selectionSchema = z.union([
  z.strictObject({ treaty: treatyDescriptor, policy: policyFormatSchema.nullable() }),
  z.strictObject({ ext: extDescriptor, policy: policyFormatSchema.extend({ fromSequence: z.literal(0) }) }),
]);
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

const SUPPORTED_COMBINATIONS = [['ext'], ['treaty']] as const;

function supportedCapabilityBase(origin: CapsOrigin): { treaty: { version: 1 } } | { ext: ExtDescriptorV1 } {
  const descriptor = origin.capabilities;
  const features = (['treaty', 'ext', 'personnel'] as const).filter((key) => Object.hasOwn(descriptor, key)).sort();
  if (
    !SUPPORTED_COMBINATIONS.some(
      (combination) =>
        combination.length === features.length && combination.every((key, index) => key === features[index]),
    )
  )
    throw new Error('아직 재생할 수 없는 기능 조합입니다.');
  if (Object.hasOwn(descriptor, 'treaty')) return { treaty: treatyDescriptor.parse(descriptor.treaty) };
  const result = extDescriptor.safeParse(descriptor.ext);
  if (!result.success) throw new Error('아직 재생할 수 없는 기능 조합입니다.');
  const ext = result.data;
  if (!sameCanonical(origin.initial.presetRules, presetRules(ext.preset)))
    throw new Error('확장 프리셋과 초기 규칙이 다릅니다.');
  return { ext };
}

export function selectSupportedCapabilities(origin: CapsOrigin, config: unknown): CapabilitySelection {
  const parsed = parseCapsOrigin(origin);
  const supported = supportedCapabilityBase(parsed);
  const options = z
    .strictObject({
      endYear: z.number().int().min(parsed.initial.startYear).max(10000).nullable(),
      outcomeFromSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      policy: policyFormatSchema.optional(),
    })
    .parse(config);
  return selectionSchema.parse({ ...supported, policy: options.policy ?? null });
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
    if (!('treaty' in selection)) throw new Error('조약을 끈 월드의 조약 입력입니다.');
    input = validateTreatyRecord(value, {
      treaty: selection.treaty,
      monthlyTick: ctx.monthlyTick,
      ...(ctx.endTick === undefined ? {} : { endTick: ctx.endTick }),
    });
  } else {
    validatePolicyRecordedInput(value, modern);
    input = structuredClone(value);
  }
  if ('ext' in selection && input.kind === 'turns.set' && input.status === 'APPLIED') {
    const resolver = createCommandResolver(selection.ext.commands);
    const { turns } = input.payload as { turns: { commandKey: string }[] };
    if (turns.some((turn) => resolver.get(turn.commandKey)?.target !== 'general'))
      throw new Error('이 월드에서 쓸 수 없는 예턴 명령입니다.');
  }
  if (ctx.endTick !== undefined && input.status !== 'REJECTED') throw new Error('종료 뒤 적용된 입력 기록입니다.');
  return input;
}

export function startCapsReplay(origin: CapsOrigin, selection: CapabilitySelection): ReplayState {
  const parsed = parseCapsOrigin(origin);
  const supported = supportedCapabilityBase(parsed);
  const selected = selectionSchema.parse(selection);
  const { policy, ...base } = selected;
  if (!sameCanonical(supported, base)) throw new Error('생성 기록과 기능 선택이 다릅니다.');
  const replay = initialReplayState(parsed.initial);
  return policy?.fromSequence === 0 ? enableReplayPolicy(replay, policy.turnTermMinutes, 0) : replay;
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
  const selection = selectionSchema.parse(ctx.selection);
  const input = validateCapsRecordedInput(value, { ...ctx, selection, monthlyTick: replay.monthlyTick });
  if (input.status === 'REJECTED') return replay;
  if (input.kind === 'system.policy.enable') return enterCapsPolicyAtMarker(replay, input, ctx.selection);
  if (CAPS_INPUT_OWNERS[input.kind] !== 'treaty') return applyRecordedInput(replay, input);
  if (!('treaty' in selection)) throw new Error('조약을 끈 월드의 조약 입력입니다.');
  const record = validateTreatyRecord(input, {
    treaty: selection.treaty,
    monthlyTick: replay.monthlyTick,
    ...(ctx.endTick === undefined ? {} : { endTick: ctx.endTick }),
  });
  const result = applyTreatyInput(replay.state, record, { tick: record.result.tick, sequence: record.sequence });
  if (!result.ok) throw new Error('조약 적용 기록을 재현하지 못했습니다.');
  const recomputed = validateTreatyRecord(
    { ...record, result: result.result },
    {
      treaty: selection.treaty,
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
  const selected = selectionSchema.parse(selection);
  const action = nextGameAction(replay);
  const resolver = 'ext' in selected ? createCommandResolver(selected.ext.commands) : undefined;
  const next = runReplayAction(replay, seed, unitSet, resolver);
  return action.kind === 'monthly' && 'treaty' in selected
    ? { ...next, state: settleTreaties(next.state, action.tick) }
    : next;
}
