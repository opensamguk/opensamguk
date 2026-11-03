import { z } from 'zod';
import { generalCreationSchema } from '../general/create';

export const LINEAGE_MAX = 2_147_483_647;
export const LINEAGE_EXITED_YEAR = LINEAGE_MAX;
export const lineageQuantity = z.number().int().min(0).max(LINEAGE_MAX);
export const lineageId = lineageQuantity.min(1);
const age = lineageQuantity.max(500);
const name = generalCreationSchema.shape.name;

// 자격과 수치는 원생성에서만 읽는다. 공개 프로필의 기본값은 만들지 않는다 (AC-P2-32).
export const lineageConfigSchema = z
  .strictObject({
    version: z.literal(1),
    marriage: z.strictObject({
      minAge: age,
      maxAge: age,
      maxSpouses: lineageId.max(4),
      kinDepth: lineageId.max(4),
      offerMonths: lineageId.max(120),
      npc: z.strictObject({
        perMonth: lineageQuantity.max(200),
        affinityGap: lineageQuantity.max(149),
        chanceBp: lineageQuantity.max(10_000),
      }),
    }),
    birth: z.strictObject({
      minParentAge: age,
      maxParentAge: age,
      chanceBp: lineageQuantity.max(10_000),
      comingOfAgeYears: lineageId.max(120),
      femaleBp: lineageQuantity.max(10_000),
      statSpread: lineageQuantity.max(1000),
      lifespan: z.strictObject({ min: lineageId.max(500), max: lineageId.max(500) }),
      givenNames: z.array(name).min(1).max(1000),
      compoundSurnames: z.array(name).max(100),
    }),
    heir: z.strictObject({ depth: lineageId.max(3) }),
    limits: z.strictObject({
      maxGenerals: lineageId.max(10_000),
      maxBirthsPerYear: lineageQuantity.max(1000),
      sentOffers: lineageId.max(200),
      receivedOffers: lineageId.max(200),
      worldOffers: lineageId.max(200),
    }),
  })
  .superRefine((config, context) => {
    if (
      config.marriage.minAge > config.marriage.maxAge ||
      config.birth.minParentAge > config.birth.maxParentAge ||
      config.birth.lifespan.min > config.birth.lifespan.max
    )
      context.addIssue({ code: 'custom', message: '가문 나이·수명의 최솟값이 최댓값을 넘었습니다.' });
    if (
      config.limits.sentOffers > config.limits.worldOffers ||
      config.limits.receivedOffers > config.limits.worldOffers
    )
      context.addIssue({ code: 'custom', path: ['limits'], message: '개인 혼인 제안 상한이 월드 상한을 넘었습니다.' });
    for (const [key, values] of [
      ['givenNames', config.birth.givenNames],
      ['compoundSurnames', config.birth.compoundSurnames],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', path: ['birth', key], message: '이름 후보가 중복됐습니다.' });
  });
export type LineageConfig = z.infer<typeof lineageConfigSchema>;
