import { z } from 'zod';
import type { RecordedInput } from '../replay';
import type { WorldView } from '../model/world';
import { applyCampaignRelationship, campaignRelationshipInputSchema } from './relationships';
import { readCampaignState } from './state';

const integer = z.number().int().min(0).max(2_147_483_647);
export const campaignRelationshipResultSchema = z.strictObject({
  accepted: z.boolean().nullable(),
  offerId: integer.min(1).nullable(),
  cost: z.union([z.literal(0), z.literal(500)]),
  chance: integer.min(25).max(75).nullable(),
  roll: integer.min(1).max(100).nullable(),
  revision: integer.min(1),
  tick: integer,
});
const rejectionSchema = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });

// 계정 제재는 엔진에서 검사한다. 적용 기록은 장수 소유권·자격·시드 결과를 다시 계산한다.
export function replayCampaignRelationship(world: WorldView, campaignValue: unknown, input: RecordedInput) {
  if (input.kind !== 'campaign.relationship') throw new Error('휘하 관계 입력 종류를 확인하세요.');
  integer.min(1).parse(input.sequence);
  integer.parse(input.tick);
  if (input.status === 'REJECTED') {
    rejectionSchema.parse(input.result);
    return { state: world, campaign: readCampaignState(campaignValue, world) };
  }
  const generalId = integer.min(1).parse(input.generalId);
  const actor = world.generals[generalId];
  if (!actor?.userId) throw new Error('휘하 관계 입력의 사람 장수가 없습니다.');
  const payload = campaignRelationshipInputSchema.parse(input.payload);
  const recorded = campaignRelationshipResultSchema.parse(input.result);
  if (recorded.tick !== input.tick) throw new Error('휘하 관계 처리 tick이 기록과 다릅니다.');
  const applied = applyCampaignRelationship(world, payload, generalId, campaignValue, {
    tick: recorded.tick,
    userId: actor.userId,
    userActive: true,
  });
  if (!applied.ok) throw new Error('휘하 관계 적용 기록을 재현하지 못했습니다.');
  const expected = campaignRelationshipResultSchema.parse({ ...applied.result, tick: recorded.tick });
  if (JSON.stringify(expected) !== JSON.stringify(recorded))
    throw new Error('휘하 관계 비용·확률·응답 결과가 기록과 다릅니다.');
  return { state: applied.state, campaign: applied.campaign };
}
