import { z } from 'zod';
import { ruleRegistry } from '../ruleRegistry';
import { resourceKeySchema } from '../world/resourceKey';

// PostgreSQL TEXT/JSONB에 저장할 수 없는 NUL·짝 없는 surrogate를 접수 전에 거부한다.
const storedString = z.string().refine(
  (value) =>
    !value.includes('\u0000') &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return character.length === 2 || code < 0xd800 || code > 0xdfff;
    }),
  '저장할 문자열을 확인하세요.',
);
const seed = storedString.min(1);
const key = z.string().regex(/^[A-Za-z0-9_-]+$/);
const interval = z.number().int().min(1).max(2_147_483_647);
const features = z.array(z.string()).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: '규칙 기능이 중복됩니다.' });
  if (values.some((value) => !ruleRegistry.features.some((feature) => feature.key === value)))
    ctx.addIssue({ code: 'custom', message: '지원하지 않는 규칙 기능입니다.' });
});
const createFields = {
  name: storedString.refine((value) => value.trim().length > 0, '월드 이름이 필요합니다.'),
  scenarioKey: resourceKeySchema.optional(),
  mapKey: resourceKeySchema.optional(),
  presetKey: key.optional(),
  statRulesKey: resourceKeySchema.optional(),
  unitSetKey: resourceKeySchema.optional(),
  portraitMapKey: resourceKeySchema.optional(),
  featureProfileKey: key.optional(),
  ruleFeatures: features.optional(),
  seed: seed.optional(),
  turnTermMinutes: interval.optional(),
  endYear: z.number().int().min(1).max(10000).nullable(),
  recruitmentLocation: z.literal('city').optional(),
};
export const requestWorldCreateInput = z
  .strictObject({
    expectedUserId: z.uuid(),
    idempotencyKey: z.uuid(),
    ...createFields,
  })
  .superRefine((value, ctx) => {
    if (!value.presetKey && (!value.scenarioKey || !value.mapKey || value.turnTermMinutes === undefined))
      ctx.addIssue({ code: 'custom', message: '프리셋 또는 시나리오·지도·턴 간격이 필요합니다.' });
    if (value.featureProfileKey !== undefined && value.ruleFeatures === undefined)
      ctx.addIssue({ code: 'custom', path: ['ruleFeatures'], message: '확장 설정의 규칙 기능 목록이 필요합니다.' });
  });
export const worldCreateIntentSchema = z.strictObject({
  version: z.literal(1),
  name: createFields.name,
  scenarioKey: resourceKeySchema.nullable(),
  mapKey: resourceKeySchema.nullable(),
  presetKey: key.nullable(),
  statRulesKey: resourceKeySchema.nullable(),
  unitSetKey: resourceKeySchema.nullable(),
  portraitMapKey: resourceKeySchema.nullable(),
  featureProfileKey: key.optional(),
  ruleFeatures: features.nullable(),
  seed: seed.nullable(),
  turnTermMinutes: interval.nullable(),
  endYear: createFields.endYear,
  recruitmentLocation: createFields.recruitmentLocation,
});
export type WorldCreateIntent = z.infer<typeof worldCreateIntentSchema>;
export function worldCreateIntent(input: z.infer<typeof requestWorldCreateInput>): WorldCreateIntent {
  const selected = (value: string | undefined) => (value === undefined ? null : resourceKeySchema.parse(value));
  return {
    version: 1,
    name: input.name.trim(),
    scenarioKey: selected(input.scenarioKey),
    mapKey: selected(input.mapKey),
    presetKey: input.presetKey ?? null,
    statRulesKey: selected(input.statRulesKey),
    unitSetKey: selected(input.unitSetKey),
    portraitMapKey: selected(input.portraitMapKey),
    ...(input.featureProfileKey === undefined ? {} : { featureProfileKey: input.featureProfileKey }),
    ruleFeatures: input.ruleFeatures === undefined ? null : [...input.ruleFeatures].sort(),
    seed: input.seed ?? null,
    turnTermMinutes: input.turnTermMinutes ?? null,
    endYear: input.endYear,
    ...(input.recruitmentLocation ? { recruitmentLocation: input.recruitmentLocation } : {}),
  };
}
export const worldCreateStatusInput = z
  .strictObject({
    expectedUserId: z.uuid(),
    idempotencyKey: z.uuid().optional(),
    requestId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.idempotencyKey === undefined) === (value.requestId === undefined))
      ctx.addIssue({ code: 'custom', message: '요청 번호나 중복 방지 번호 중 하나가 필요합니다.' });
  });
export const worldCreateRejectMessages = {
  ACTOR_INACTIVE: '활성 관리자 계정이 아닙니다.',
  ADMIN_REQUIRED: '관리자 권한이 없습니다.',
  ACTOR_SANCTIONED: '이용이 제한된 계정입니다.',
  RESOURCE_INVALID: '고정한 생성 자원을 확인하지 못했습니다.',
  INPUT_INVALID: '월드 생성 설정을 확인하세요.',
} as const;
export type WorldCreateRejectCode = keyof typeof worldCreateRejectMessages;
