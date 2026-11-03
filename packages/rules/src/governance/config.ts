import { z } from 'zod';
import { CITY_RESOURCE_MAX } from '../cityResources/state';
import type { WorldView } from '../model/world';

export const GOVERNANCE_OFFICES = ['chancellor', 'grandMarshal', 'minister'] as const;
export const governanceQuantity = z.number().int().min(0).max(CITY_RESOURCE_MAX);
export const governanceId = governanceQuantity.min(1);
const basisPoints = governanceQuantity.max(10_000);
const legitimacy = governanceQuantity.max(100);

// 숫자는 원생성에서만 정한다. 공개 프로필에 적용할 기본값은 이 모듈에서 만들지 않는다.
export const governanceConfigSchema = z
  .strictObject({
    version: z.literal(1),
    seatCityKey: governanceId,
    legitimacy: z.strictObject({
      seatGain: legitimacy,
      emperorGain: legitimacy,
      officeGain: legitimacy,
      maxOfficeGain: legitimacy,
      decay: legitimacy,
      ascendAt: legitimacy.min(1),
      censureLoss: legitimacy,
      renounceLoss: legitimacy,
    }),
    tribute: z.strictObject({ maxBp: basisPoints, maxAmount: governanceQuantity }),
    stipendGold: z.strictObject({
      chancellor: governanceQuantity,
      grandMarshal: governanceQuantity,
      minister: governanceQuantity,
    }),
    offerMonths: governanceId.max(120),
    maxDepth: governanceId.max(3),
    maxRemitMonths: governanceId.max(12),
    censureCooldownMonths: governanceId.max(120),
    npc: z.strictObject({
      cityRatio: governanceId.max(10_000),
      acceptMaxBp: basisPoints,
      offerBp: basisPoints,
      cooldownMonths: governanceId.max(120),
    }),
    limits: z.strictObject({
      sentOffers: governanceId.max(200),
      receivedOffers: governanceId.max(200),
      worldOffers: governanceId.max(200),
    }),
  })
  .superRefine((config, ctx) => {
    if (config.npc.offerBp > config.tribute.maxBp || config.npc.acceptMaxBp > config.tribute.maxBp)
      ctx.addIssue({ code: 'custom', path: ['npc'], message: 'NPC 공납 비율이 월드 상한을 넘었습니다.' });
    if (
      config.limits.sentOffers > config.limits.worldOffers ||
      config.limits.receivedOffers > config.limits.worldOffers
    )
      ctx.addIssue({ code: 'custom', path: ['limits'], message: '국가별 제안 상한이 월드 상한을 넘었습니다.' });
  });
export type GovernanceConfig = z.infer<typeof governanceConfigSchema>;
export type GovernanceOffice = (typeof GOVERNANCE_OFFICES)[number];

export function readGovernanceConfig(value: unknown, world: Pick<WorldView, 'cities'>): GovernanceConfig {
  const config = governanceConfigSchema.parse(value);
  const seat = world.cities[config.seatCityKey];
  if (!seat || seat.kind === 'PASS') throw new Error('천자 소재지는 존재하는 도시 거점이어야 합니다.');
  return config;
}
