import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { DeepReadonly, WorldView } from '../model/world';
import type { RecordedInput, ReplayState } from '../replay';
import type { InitialNation } from '../world/bootstrap';

export const NATION_RESTRICTIONS_FEATURE = 'nation-restrictions-v1';
export const NATION_RESTRICTIONS_KIND = 'nation.setRestrictions';
export const NATION_RESTRICTIONS_MIN_OFFICE = 5;
const MAX_WAR_CHANGES = 10;
const WAR_CHANGES_PER_MONTH = 2;
export const nationRestrictionsInput = z
  .strictObject({
    nationId: z.number().int().positive().max(2_147_483_647),
    setting: z.enum(['recruitment', 'war', 'confidential']),
    blocked: z.boolean().optional(),
    confidentialYears: z.number().int().min(1).max(99).optional(),
  })
  .refine(({ setting, blocked, confidentialYears }) =>
    setting === 'confidential'
      ? confidentialYears !== undefined && blocked === undefined
      : blocked !== undefined && confidentialYears === undefined,
  );
const settingsSchema = z.strictObject({
  recruitmentBlocked: z.boolean(),
  warBlocked: z.boolean(),
  warChanges: z.number().int().min(0).max(MAX_WAR_CHANGES),
  warMonth: z.number().int().min(0),
  confidentialYears: z.number().int().min(1).max(99).optional(),
});
export type NationRestrictions = z.infer<typeof settingsSchema>;
const defaults: NationRestrictions = {
  recruitmentBlocked: false,
  warBlocked: false,
  warChanges: 0,
  warMonth: 0,
};

export function storedNationRestrictions(enabled: boolean, raw: unknown) {
  if (raw == null) return {};
  if (!enabled) throw new Error('국가 제한을 끈 월드에 저장된 설정이 있습니다.');
  return { restrictions: settingsSchema.parse(raw) };
}

export function nationRestrictions(
  view: Pick<WorldView, 'ruleFeatures'>,
  nation: DeepReadonly<Pick<InitialNation, 'restrictions'>> | undefined,
  tick = 0,
) {
  if (!view.ruleFeatures?.includes(NATION_RESTRICTIONS_FEATURE)) return defaults;
  const current = nation?.restrictions ?? defaults;
  const month = Math.floor(tick / TICKS_PER_MONTH);
  return {
    ...current,
    warMonth: month,
    warChanges: Math.min(
      MAX_WAR_CHANGES,
      current.warChanges + WAR_CHANGES_PER_MONTH * Math.max(0, month - current.warMonth),
    ),
  };
}

export function changeNationRestrictions(
  current: NationRestrictions,
  input: z.infer<typeof nationRestrictionsInput>,
): NationRestrictions | null {
  if (input.setting === 'confidential') return { ...current, confidentialYears: input.confidentialYears! };
  if (input.setting === 'recruitment') return { ...current, recruitmentBlocked: input.blocked! };
  if (input.blocked === current.warBlocked) return current;
  return current.warChanges === 0
    ? null
    : { ...current, warBlocked: input.blocked!, warChanges: current.warChanges - 1 };
}

export function applyNationRestrictions(replay: ReplayState, input: RecordedInput): ReplayState {
  const request = nationRestrictionsInput.parse(input.payload);
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  const nation = replay.state.nations[request.nationId];
  if (
    !actor ||
    actor.userId === null ||
    actor.removedAt !== undefined ||
    actor.nationId !== request.nationId ||
    actor.officerLevel < NATION_RESTRICTIONS_MIN_OFFICE ||
    !nation ||
    input.tick == null
  )
    throw new Error('국가 제한을 설정할 수 있는 장수가 아닙니다.');
  const result = settingsSchema.parse(input.result);
  const changed = changeNationRestrictions(nationRestrictions(replay.state, nation, input.tick), request);
  if (
    !changed ||
    [...Object.keys(changed), ...Object.keys(result)].some(
      (key) => changed[key as keyof NationRestrictions] !== result[key as keyof NationRestrictions],
    )
  )
    throw new Error('국가 제한 변경 기록이 올바르지 않습니다.');
  const next = structuredClone(replay);
  next.state.nations[nation.id]!.restrictions = changed;
  return next;
}
