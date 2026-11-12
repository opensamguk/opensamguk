import { z } from 'zod';
import { presetSchema, presetRules, type WorldPreset, type PresetRules } from './preset';
import { truceSchema } from '../clock/truce';

const nonempty = (value: object) => Object.values(value).some((entry) => entry !== undefined);
export const runtimeRuleOptionsSchema = z
  .strictObject({
    protection: presetSchema.shape.protection
      .omit({ maxGeneralsPerNation: true })
      .partial()
      .refine(nonempty)
      .optional(),
    npc: presetSchema.shape.npc.omit({ fillRatio: true }).partial().refine(nonempty).optional(),
    boost: presetSchema.shape.boost.partial().refine(nonempty).optional(),
  })
  .refine(nonempty);
export const generalCreationEntrySchema = z.enum(['open', 'closed']);
export const npcPlayEntrySchema = z.enum(['off', 'on']);
export const recruitmentLocationSchema = z.enum(['territory', 'city']);
export const runtimeOptionsSchema = z
  .strictObject({
    rules: runtimeRuleOptionsSchema.optional(),
    entry: z
      .strictObject({ generalCreation: generalCreationEntrySchema.optional(), npcPlay: npcPlayEntrySchema.optional() })
      .refine(nonempty)
      .optional(),
    truce: truceSchema.nullable().optional(),
    recruitmentLocation: recruitmentLocationSchema.optional(),
  })
  .refine(nonempty);
export type RuntimeRuleOptions = z.infer<typeof runtimeRuleOptionsSchema>;
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;

export function mergeRuntimeRules(
  before: RuntimeRuleOptions | undefined,
  patch: RuntimeRuleOptions,
): RuntimeRuleOptions {
  return runtimeRuleOptionsSchema.parse({
    ...before,
    ...(patch.protection ? { protection: { ...before?.protection, ...patch.protection } } : {}),
    ...(patch.npc ? { npc: { ...before?.npc, ...patch.npc } } : {}),
    ...(patch.boost ? { boost: { ...before?.boost, ...patch.boost } } : {}),
  });
}
export function applyRuleOptions(before: PresetRules, patch: RuntimeRuleOptions): PresetRules {
  const next = {
    protection: presetSchema.shape.protection.parse({ ...before.protection, ...patch.protection }),
    npc: presetSchema.shape.npc.pick({ aggression: true }).parse({ ...before.npc, ...patch.npc }),
    boost: presetSchema.shape.boost.parse({ ...before.boost, ...patch.boost }),
  };
  return structuredClone(next);
}
// 생성 원본은 바꾸지 않는다. 생략한 입장 설정은 기본값을 쓴다.
export function effectiveWorldOptions(preset: WorldPreset | null, stored: unknown = null) {
  const runtime = stored == null ? null : runtimeOptionsSchema.parse(stored);
  if (runtime?.rules && preset === null) throw Error('프리셋 없는 월드에 규칙 옵션이 저장됐습니다.');
  const rules = preset === null ? undefined : presetRules(preset);
  return {
    presetRules:
      rules === undefined ? undefined : runtime?.rules === undefined ? rules : applyRuleOptions(rules, runtime.rules),
    entry: { generalCreation: runtime?.entry?.generalCreation ?? 'open', npcPlay: runtime?.entry?.npcPlay ?? 'off' },
    truce: runtime?.truce === undefined ? (preset?.truce ?? null) : runtime.truce,
    recruitmentLocation: runtime?.recruitmentLocation ?? 'territory',
  };
}
