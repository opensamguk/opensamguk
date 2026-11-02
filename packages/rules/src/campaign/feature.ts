import { z } from 'zod';
import type { RuleFeatureDefinition, InputKindDefinition } from '../ruleRegistry';
import type { WorldInit } from '../world/bootstrap';
import type { ReplayState, RecordedInput } from '../replay';
import { cloneWorld } from '../model/clone';
import { toWorldState } from '../model/world';
import { followCampaignCommanders } from './movement';
import { emptyCampaignState, readCampaignState } from './state';
import {
  replayCampaignRelationship,
  replayCampaignUnit,
  campaignRelationshipResultSchema,
  campaignUnitResultSchema,
} from './record';
import { campaignRelationshipInputSchema } from './relationships';
import { campaignUnitInputSchema } from './unitInputs';
import { campaignOrderInputSchema, campaignOrderResultSchema, sameOrderValue } from './orderTypes';
import { applyCampaignOrder } from './orders';

const integer = z.number().int().min(0).max(2_147_483_647);
const rejection = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });
export function campaignArmyTypes(initial: Pick<WorldInit, 'unitSet'>): number[] {
  const ids = initial.unitSet.crewTypes
    .filter((type) => type.armType > 0)
    .map((type) => type.id)
    .sort((a, b) => a - b);
  z.array(integer.min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length)
    .parse(ids);
  return ids;
}
export function validateCampaignRecord(input: RecordedInput) {
  integer.min(1).parse(input.sequence);
  integer.parse(input.tick);
  if (input.kind === 'campaign.order') campaignOrderInputSchema.parse(input.payload);
  if (input.status === 'REJECTED') {
    rejection.parse(input.result);
    return;
  }
  integer.min(1).parse(input.generalId);
  const result =
    input.kind === 'campaign.relationship'
      ? (campaignRelationshipInputSchema.parse(input.payload), campaignRelationshipResultSchema.parse(input.result))
      : input.kind === 'campaign.unit'
        ? (campaignUnitInputSchema.parse(input.payload), campaignUnitResultSchema.parse(input.result))
        : input.kind === 'campaign.order'
          ? (campaignOrderInputSchema.parse(input.payload), campaignOrderResultSchema.parse(input.result))
          : null;
  if (!result || result.tick !== input.tick) throw new Error('휘하·부곡 입력 처리 기록을 확인하세요.');
}

export const campaignFeature: RuleFeatureDefinition = {
  key: 'campaign-v1',
  requires: ['five-stats', 'operational-map', 'personnel', 'policy'],
  conflicts: ['ext'],
  checkOrigin({ initial, data }) {
    if (
      data !== undefined ||
      initial.generals.some((general) => general.crew !== 0) ||
      Object.hasOwn(initial, 'campaign')
    )
      throw new Error('새 휘하 프로필은 병력이 없는 생성 기록에서 시작합니다.');
    const state = toWorldState(initial);
    emptyCampaignState(state, initial.seed, initial.scenarioKey);
    campaignArmyTypes(initial);
  },
  initReplayState(replay, { initial }) {
    return {
      ...replay,
      state: { ...replay.state, campaign: emptyCampaignState(replay.state, initial.seed, initial.scenarioKey) },
      campaignArmyTypes: campaignArmyTypes(initial),
      campaignUnitSet: initial.unitSet,
    };
  },
  checkArchive({ origin, inputs }) {
    const types = campaignArmyTypes(origin.initial);
    for (const input of inputs)
      if (['campaign.relationship', 'campaign.unit', 'campaign.order'].includes(input.kind)) {
        validateCampaignRecord(input);
        if (input.kind === 'campaign.unit' && input.status === 'APPLIED') {
          const payload = campaignUnitInputSchema.parse(input.payload);
          if (payload.type === 'form' && !types.includes(payload.crewType))
            throw new Error('생성 기록에 없는 부곡 병종입니다.');
        }
      }
  },
  afterAppliedInput(before, after, input) {
    if (input.kind === 'general.create') {
      const state = cloneWorld(after.state),
        campaign = readCampaignState(before.state.campaign, before.state);
      const generalId = integer.min(1).parse(input.generalId);
      if (!state.generals[generalId] || state.generals[generalId]!.crew !== 0 || campaign.sources[String(generalId)])
        throw new Error('새 사람 장수의 부곡 생성 출처를 확인하세요.');
      if (campaign.revision === 2_147_483_647) throw new Error('휘하 변경 번호 한도를 넘었습니다.');
      campaign.sources[String(generalId)] = `input:${integer.min(1).parse(input.sequence)}#general:${generalId}`;
      campaign.revision++;
      state.campaign = readCampaignState(campaign, state, campaign.seed);
      return { ...after, state };
    }
    return { ...after, state: followCampaignCommanders(before.state, after.state) };
  },
};
function applyCampaign(
  replay: ReplayState,
  input: RecordedInput,
  context?: Parameters<InputKindDefinition['apply']>[2],
): ReplayState {
  validateCampaignRecord(input);
  if (!replay.campaignArmyTypes) throw new Error('부곡 생성 병종 목록이 없습니다.');
  if (input.kind === 'campaign.order') {
    const actor = replay.state.generals[input.generalId!];
    if (!actor?.userId || !replay.campaignUnitSet) throw new Error('휘하 지시의 장수·병종 출처가 없습니다.');
    if (!context?.resolver) throw new Error('휘하 지시를 재생할 명령 해석기가 없습니다.');
    const result = applyCampaignOrder(replay.state, input.payload, actor.id, {
      tick: input.tick!,
      userId: actor.userId,
      userActive: true,
      turns: replay.turns,
      revisions: replay.revisions,
      resolver: context.resolver,
      unitSet: replay.campaignUnitSet,
    });
    if (!result.ok || !sameOrderValue({ ...result.result, tick: input.tick }, input.result))
      throw new Error('휘하 지시 적용 결과를 재현하지 못했습니다.');
    return { ...replay, state: result.state };
  }
  if (input.kind === 'campaign.relationship') {
    const result = replayCampaignRelationship(replay.state, replay.state.campaign, input);
    return { ...replay, state: { ...cloneWorld(result.state), campaign: result.campaign } };
  }
  return { ...replay, state: cloneWorld(replayCampaignUnit(replay.state, input, replay.campaignArmyTypes)) };
}
export const campaignInputKinds: readonly InputKindDefinition[] = [
  'campaign.relationship',
  'campaign.unit',
  'campaign.order',
].map((kind) => ({
  kind,
  feature: 'campaign-v1',
  route: 'queued',
  apply: applyCampaign,
}));
