import { z } from 'zod';
import { createCommandResolver } from '../commands/resolve';

const integer = z.number().int().min(0).max(2_147_483_647);
const resourceKey = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const commands = z.strictObject({ general: z.array(resourceKey), nation: z.array(resourceKey) });
const protection = z.strictObject({
  foundUntilMonths: integer,
  peaceMonths: integer,
  // P-6 유한 정원 정책이 정해질 때까지 무제한만 받는다.
  maxGeneralsPerNation: z.null(),
});
const boost = z.strictObject({
  smallWorld: z
    .array(z.strictObject({ below: integer.min(1), multiplier: z.number().gt(1).max(3) }))
    .min(1)
    .refine(
      (rows) => rows.every((row, i) => i === 0 || row.below > rows[i - 1]!.below),
      '인원 기준은 오름차순이어야 합니다.',
    )
    .nullable(),
  lateJoin: z
    .strictObject({
      fromYear: integer,
      experienceRatio: z.number().gt(0).max(1),
      percentile: z.number().gt(0).max(1),
      goldPerYear: integer,
      ricePerYear: integer,
      maxYears: integer,
    })
    .refine(
      (value) =>
        1000 + value.goldPerYear * value.maxYears <= 2_147_483_647 &&
        1000 + value.ricePerYear * value.maxYears <= 2_147_483_647,
      '장수 자원 저장 범위를 넘었습니다.',
    )
    .nullable(),
});

export const presetSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    turnTermMinutes: integer.min(1),
    scenario: resourceKey,
    map: resourceKey,
    unitSet: resourceKey,
    commands: commands
      .nullable()
      .optional()
      .transform((value) => (value && (value.general.length || value.nation.length) ? value : null)),
    npc: z.strictObject({ fillRatio: z.literal(1), aggression: z.number().gt(0).max(3) }),
    protection,
    boost,
    features: z.strictObject({ advisor: z.boolean() }),
  })
  .superRefine((value, context) => {
    try {
      createCommandResolver(value.commands);
    } catch {
      context.addIssue({ code: 'custom', path: ['commands'], message: '확장 명령 설정을 확인하세요.' });
    }
  });

export type WorldPreset = z.infer<typeof presetSchema>;
export interface PresetRules {
  protection: WorldPreset['protection'];
  npc: { aggression: number };
  boost: WorldPreset['boost'];
}
export function parsePreset(value: unknown): WorldPreset {
  return presetSchema.parse(value);
}
export function presetCommands(preset: WorldPreset | null) {
  return preset?.commands ?? null;
}
export function resolverForPreset(preset: WorldPreset | null) {
  return createCommandResolver(presetCommands(preset));
}
export function presetRules(preset: WorldPreset): PresetRules {
  return structuredClone({
    protection: preset.protection,
    npc: { aggression: preset.npc.aggression },
    boost: preset.boost,
  });
}
