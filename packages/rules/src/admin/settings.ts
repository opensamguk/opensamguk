import { z } from 'zod';
import { adminClockPayloadSchema, adminClockRejectMessages } from '../clock/admin';
import { requestWorldResetInput } from '../clock/reset';
import { presetSchema } from '../world/preset';
import { toGameDate } from '../clock/clock';
import {
  applyRuleOptions,
  effectiveWorldOptions,
  mergeRuntimeRules,
  type RuntimeOptions,
  type RuntimeRuleOptions,
} from '../world/options';
import type { WorldPreset, PresetRules } from '../world/preset';
import type { JsonValue } from '../model/world';
import type { RecordedInput, ReplayState } from '../replay';
import { sameJson, type AdminGameContext } from './apply';

const integer = z.number().int().min(0).max(2_147_483_647);
const storedName = requestWorldResetInput.shape.confirmName;
const name = storedName.trim().min(1).max(100);
const endYear = z.number().int().min(1).max(10000).nullable();
const term = presetSchema.shape.turnTermMinutes;
const option = <K extends string, S extends z.ZodType>(key: K, value: S) =>
  z.strictObject({ kind: z.literal('admin.world.setOption'), key: z.literal(key), value });
export const adminSettingSchema = z.union([
  z.strictObject({ kind: z.literal('admin.world.rename'), name }),
  z.strictObject({ kind: z.literal('admin.world.setEndYear'), endYear }),
  z.strictObject({ kind: z.literal('admin.world.setTurnTerm'), turnTermMinutes: term }),
  option('protection.foundUntilMonths', presetSchema.shape.protection.shape.foundUntilMonths),
  option('protection.peaceMonths', presetSchema.shape.protection.shape.peaceMonths),
  option('npc.aggression', presetSchema.shape.npc.shape.aggression),
  option('boost.smallWorld', presetSchema.shape.boost.shape.smallWorld),
  option('boost.lateJoin', presetSchema.shape.boost.shape.lateJoin),
]);
export const ADMIN_SETTING_KINDS = [
  'admin.world.rename',
  'admin.world.setEndYear',
  'admin.world.setTurnTerm',
  'admin.world.setOption',
] as const;
export const adminSettingPayloadSchema = z.strictObject({
  version: z.literal(1),
  reason: adminClockPayloadSchema.shape.reason,
  setting: adminSettingSchema,
});
export type AdminSetting = z.infer<typeof adminSettingSchema>;
export const adminSettingRejectMessages = {
  ...adminClockRejectMessages,
  END_YEAR_PASSED: '지금 연도보다 이른 종료 연도로 바꿀 수 없습니다.',
  NO_PRESET: '프리셋 없는 월드에서는 규칙 옵션을 바꿀 수 없습니다.',
  UNCHANGED: '지금 값과 같습니다.',
  INVALID_VALUE: '바꿀 설정의 값과 범위를 확인하세요.',
} as const;
type RejectCode = keyof typeof adminSettingRejectMessages;
export const adminSettingRejectedSchema = z
  .strictObject({
    code: z.enum(Object.keys(adminSettingRejectMessages) as [RejectCode, ...RejectCode[]]),
    message: z.string(),
  })
  .refine((result) => result.message === adminSettingRejectMessages[result.code]);

function snapshot(setting: AdminSetting): z.ZodType<JsonValue> {
  switch (setting.kind) {
    case 'admin.world.rename':
      return z.strictObject({ name: storedName });
    case 'admin.world.setEndYear':
      return z.strictObject({ endYear });
    case 'admin.world.setTurnTerm':
      return z.strictObject({ turnTermMinutes: term });
    case 'admin.world.setOption': {
      const value =
        setting.key === 'protection.foundUntilMonths'
          ? presetSchema.shape.protection.shape.foundUntilMonths
          : setting.key === 'protection.peaceMonths'
            ? presetSchema.shape.protection.shape.peaceMonths
            : setting.key === 'npc.aggression'
              ? presetSchema.shape.npc.shape.aggression
              : setting.key === 'boost.smallWorld'
                ? presetSchema.shape.boost.shape.smallWorld
                : presetSchema.shape.boost.shape.lateJoin;
      return z.strictObject({ value });
    }
  }
}
export function adminSettingAppliedSchema(setting: AdminSetting) {
  const value = snapshot(setting);
  return z.strictObject({ version: z.literal(1), before: value, after: value });
}
export function isAdminSettingKind(kind: string): kind is (typeof ADMIN_SETTING_KINDS)[number] {
  return (ADMIN_SETTING_KINDS as readonly string[]).includes(kind);
}
export interface WorldSettings {
  name: string;
  endYear: number | null;
  turnTermMinutes: number;
  startYear: number;
  preset: WorldPreset | null;
  runtimeOptions: RuntimeOptions | null;
}
type OptionSetting = Extract<AdminSetting, { kind: 'admin.world.setOption' }>;
export function ruleOptionPatch(setting: OptionSetting): RuntimeRuleOptions {
  switch (setting.key) {
    case 'protection.foundUntilMonths':
      return { protection: { foundUntilMonths: setting.value } };
    case 'protection.peaceMonths':
      return { protection: { peaceMonths: setting.value } };
    case 'npc.aggression':
      return { npc: { aggression: setting.value } };
    case 'boost.smallWorld':
      return { boost: { smallWorld: setting.value } };
    case 'boost.lateJoin':
      return { boost: { lateJoin: setting.value } };
  }
}
function optionValue(rules: PresetRules, setting: OptionSetting): JsonValue {
  switch (setting.key) {
    case 'protection.foundUntilMonths':
      return rules.protection.foundUntilMonths;
    case 'protection.peaceMonths':
      return rules.protection.peaceMonths;
    case 'npc.aggression':
      return rules.npc.aggression;
    case 'boost.smallWorld':
      return structuredClone(rules.boost.smallWorld);
    case 'boost.lateJoin':
      return structuredClone(rules.boost.lateJoin);
  }
}
type Applied = z.infer<ReturnType<typeof adminSettingAppliedSchema>>;
type Rejected = z.infer<typeof adminSettingRejectedSchema>;
type Outcome =
  | { status: 'APPLIED'; result: Applied; replay: ReplayState; settings: WorldSettings }
  | { status: 'REJECTED'; result: Rejected; replay: ReplayState; settings: WorldSettings };
type Context = Pick<AdminGameContext, 'userActive' | 'admin' | 'sanctioned' | 'replayFormat' | 'worldStatus'> & {
  tick: number;
};
export function decideAdminSetting(
  replay: ReplayState,
  current: WorldSettings,
  payload: unknown,
  context: Context,
): Outcome {
  const reject = (code: RejectCode): Outcome => ({
    status: 'REJECTED',
    result: { code, message: adminSettingRejectMessages[code] },
    replay,
    settings: current,
  });
  if (!context.userActive) return reject('ACTOR_INACTIVE');
  if (!context.admin) return reject('ADMIN_REQUIRED');
  if (context.sanctioned) return reject('ACTOR_SANCTIONED');
  if (context.replayFormat !== 3) return reject('UNSUPPORTED_FORMAT');
  if (!['RUNNING', 'PAUSED'].includes(context.worldStatus)) return reject('WORLD_STATE_CHANGED');
  const parsed = adminSettingPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject('INVALID_VALUE');
  integer.parse(context.tick);
  const setting = parsed.data.setting,
    settings = structuredClone(current),
    next = structuredClone(replay);
  let before: JsonValue, after: JsonValue;
  switch (setting.kind) {
    case 'admin.world.rename':
      before = { name: current.name };
      after = { name: setting.name };
      settings.name = setting.name;
      break;
    case 'admin.world.setEndYear':
      if (setting.endYear !== null && setting.endYear < toGameDate(current.startYear, context.tick).year)
        return reject('END_YEAR_PASSED');
      before = { endYear: current.endYear };
      after = { endYear: setting.endYear };
      settings.endYear = setting.endYear;
      break;
    case 'admin.world.setTurnTerm':
      before = { turnTermMinutes: current.turnTermMinutes };
      after = { turnTermMinutes: setting.turnTermMinutes };
      settings.turnTermMinutes = setting.turnTermMinutes;
      if (next.policy) next.policy.turnTermMinutes = setting.turnTermMinutes;
      break;
    case 'admin.world.setOption': {
      const effective = effectiveWorldOptions(current.preset, current.runtimeOptions);
      if (!effective.presetRules) return reject('NO_PRESET');
      if (
        replay.state.presetRules === undefined ||
        !sameJson(z.json().parse(effective.presetRules), z.json().parse(replay.state.presetRules))
      )
        throw Error('저장된 유효 규칙과 현재 상태가 다릅니다.');
      before = { value: optionValue(effective.presetRules, setting) };
      after = { value: setting.value };
      const patch = ruleOptionPatch(setting);
      settings.runtimeOptions = { rules: mergeRuntimeRules(current.runtimeOptions?.rules, patch) };
      next.state.presetRules = applyRuleOptions(effective.presetRules, patch);
      break;
    }
  }
  if (sameJson(before, after)) return reject('UNCHANGED');
  return {
    status: 'APPLIED',
    result: adminSettingAppliedSchema(setting).parse({ version: 1, before, after }),
    replay: next,
    settings,
  };
}

export function validateAdminSettingRecord(input: RecordedInput): void {
  const keys = ['sequence', 'tick', 'generalId', 'kind', 'status', 'payload', 'result'];
  if (
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key)) ||
    input.generalId !== null ||
    !isAdminSettingKind(input.kind)
  )
    throw Error('관리자 설정 입력 기록을 확인하세요.');
  integer.min(1).parse(input.sequence);
  integer.parse(input.tick);
  const payload = adminSettingPayloadSchema.parse(input.payload);
  if (payload.setting.kind !== input.kind) throw Error('설정 입력 종류와 값이 다릅니다.');
  if (input.status === 'APPLIED') {
    const result = adminSettingAppliedSchema(payload.setting).parse(input.result),
      setting = payload.setting;
    const expected =
      setting.kind === 'admin.world.rename'
        ? { name: setting.name }
        : setting.kind === 'admin.world.setEndYear'
          ? { endYear: setting.endYear }
          : setting.kind === 'admin.world.setTurnTerm'
            ? { turnTermMinutes: setting.turnTermMinutes }
            : { value: setting.value };
    if (!sameJson(result.after, expected)) throw Error('설정 입력과 적용한 값이 다릅니다.');
  } else if (input.status === 'REJECTED') adminSettingRejectedSchema.parse(input.result);
  else throw Error('완료된 관리자 설정 입력이 필요합니다.');
}

export function applyAdminSettingRecord(replay: ReplayState, input: RecordedInput): ReplayState {
  validateAdminSettingRecord(input);
  if (input.status === 'REJECTED') return replay;
  const { setting } = adminSettingPayloadSchema.parse(input.payload);
  const result = adminSettingAppliedSchema(setting).parse(input.result),
    before = result.before as Record<string, JsonValue>;
  if (setting.kind === 'admin.world.rename' || setting.kind === 'admin.world.setEndYear') return replay;
  const next = structuredClone(replay);
  if (setting.kind === 'admin.world.setTurnTerm') {
    if (next.policy) {
      if (next.policy.turnTermMinutes !== before.turnTermMinutes)
        throw Error('턴 간격의 변경 전 값이 재생과 다릅니다.');
      next.policy.turnTermMinutes = setting.turnTermMinutes;
    }
  } else {
    if (!next.state.presetRules || !sameJson(optionValue(next.state.presetRules, setting), before.value!))
      throw Error('규칙 옵션의 변경 전 값이 재생과 다릅니다.');
    next.state.presetRules = applyRuleOptions(next.state.presetRules, ruleOptionPatch(setting));
  }
  return next;
}

function creationValue(current: JsonValue, inputs: readonly RecordedInput[], kind: string, field: string): JsonValue {
  let value = current;
  for (const input of inputs.filter((input) => input.kind === kind).toSorted((a, b) => b.sequence - a.sequence)) {
    validateAdminSettingRecord(input);
    if (input.status === 'REJECTED') continue;
    const { setting } = adminSettingPayloadSchema.parse(input.payload);
    const result = adminSettingAppliedSchema(setting).parse(input.result);
    const before = result.before as Record<string, JsonValue>,
      after = result.after as Record<string, JsonValue>;
    if (!sameJson(after[field]!, value)) throw Error('현재 설정과 적용한 변경 이력이 다릅니다.');
    value = before[field]!;
  }
  return value;
}
export function creationSettings(
  world: Pick<WorldSettings, 'name' | 'turnTermMinutes' | 'endYear'>,
  inputs: readonly RecordedInput[],
) {
  return {
    name: storedName.parse(creationValue(world.name, inputs, 'admin.world.rename', 'name')),
    turnTermMinutes: term.parse(
      creationValue(world.turnTermMinutes, inputs, 'admin.world.setTurnTerm', 'turnTermMinutes'),
    ),
    endYear: endYear.parse(creationValue(world.endYear, inputs, 'admin.world.setEndYear', 'endYear')),
  };
}
export function creationEndYear(archive: { config: { endYear: number | null }; inputs: readonly RecordedInput[] }) {
  return endYear.parse(creationValue(archive.config.endYear, archive.inputs, 'admin.world.setEndYear', 'endYear'));
}

export function creationName(currentName: string, inputs: readonly RecordedInput[]) {
  return storedName.parse(creationValue(currentName, inputs, 'admin.world.rename', 'name'));
}
