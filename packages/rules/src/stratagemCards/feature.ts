import { z } from 'zod';
import type { RecordedInput } from '../replay';
import type { InputKindDefinition, RuleFeatureDefinition } from '../ruleRegistry';
import { toWorldState } from '../model/world';
import { cardId, cardQuantity, stratagemCardsConfigSchema } from './config';
import { decideStratagemCardsAction, stratagemCardsInputSchema } from './actions';
import { initialStratagemCards, reconcileStratagemCards } from './state';
import { settleStratagemCards } from './monthly';

export const stratagemCardsFeatureDataSchema = z.strictObject({
  version: z.literal(1),
  config: stratagemCardsConfigSchema,
});
export const stratagemCardsResultSchema = z.strictObject({
  action: z.literal('trap.set'),
  revision: cardId,
  tick: cardQuantity,
});
const rejectionSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export function readStratagemCardsConfig(data: unknown, ruleFeatures: readonly string[] = []) {
  const { config } = stratagemCardsFeatureDataSchema.parse(data);
  if (!config.consumeOnRollFailure || config.campaignLoss !== 'eligibleAll' || config.setter !== 'ruler')
    throw Error('아직 구현하지 않은 계략 패 규칙입니다.');
  if (config.deck.some((card) => card.kind.startsWith('nation_')) && !ruleFeatures.includes('nation-strategy-v1'))
    throw Error('국가 전략 패는 전략 기능 구현 뒤 등록합니다.');
  return config;
}

export function validateStratagemCardsRecord(input: RecordedInput) {
  if (input.kind !== 'stratagem-cards.act') throw Error('계략 패 입력 종류를 확인하세요.');
  cardId.parse(input.sequence);
  cardQuantity.parse(input.tick);
  if (input.status === 'REJECTED') {
    rejectionSchema.parse(input.result);
    return;
  }
  cardId.parse(input.generalId);
  stratagemCardsInputSchema.parse(input.payload);
  const result = stratagemCardsResultSchema.parse(input.result);
  if (result.tick !== input.tick) throw Error('계략 패 입력과 결과 시각이 다릅니다.');
}

// 설정은 원생성에 명시한다. 공개 생성 목록과 운영 기본값은 별도로 정한다.
export const stratagemCardsFeature: RuleFeatureDefinition = {
  key: 'stratagem-cards-v1',
  requires: ['personnel', 'stratagem-basic'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'stratagemCards')) throw Error('계략 패는 원생성의 빈 상태에서 시작합니다.');
    initialStratagemCards(readStratagemCardsConfig(data, initial.ruleFeatures), toWorldState(initial), initial.seed);
  },
  initReplayState(replay, { initial, data }) {
    if (Object.hasOwn(replay.state, 'stratagemCards')) throw Error('계략 패 초기화가 중복됐습니다.');
    return {
      ...replay,
      state: {
        ...replay.state,
        stratagemCards: initialStratagemCards(
          readStratagemCardsConfig(data, initial.ruleFeatures),
          replay.state,
          initial.seed,
        ),
      },
    };
  },
  checkArchive({ inputs }) {
    for (const input of inputs) if (input.kind === 'stratagem-cards.act') validateStratagemCardsRecord(input);
  },
  afterAppliedInput(_before, after, _input, context) {
    if (context?.route !== 'queued') return after;
    return {
      ...after,
      state: {
        ...after.state,
        stratagemCards: reconcileStratagemCards(after.state, after.state.stratagemCards, after.monthlyTick),
      },
    };
  },
  settleMonthly({ before, settled, tick }) {
    if (settled.state.stratagemCards?.monthlyTick !== before.monthlyTick || settled.monthlyTick !== tick)
      throw Error('계략 패와 월드의 월간 정산 시각이 다릅니다.');
    const { state, draws } = settleStratagemCards(settled.state, settled.state.stratagemCards, tick);
    return { replay: { ...settled, state: { ...settled.state, stratagemCards: state } }, effects: { draws } };
  },
};

export const stratagemCardsInputKind: InputKindDefinition = {
  kind: 'stratagem-cards.act',
  feature: 'stratagem-cards-v1',
  route: 'queued',
  apply(replay, input) {
    validateStratagemCardsRecord(input);
    if (input.status === 'REJECTED') return replay;
    const actor = replay.state.generals[input.generalId!];
    if (!actor?.userId) throw Error('계략 패 입력의 사람 장수가 없습니다.');
    const result = decideStratagemCardsAction(replay.state, actor.id, input.payload, input.tick!);
    if (
      !result.ok ||
      JSON.stringify(stratagemCardsResultSchema.parse(result.result)) !==
        JSON.stringify(stratagemCardsResultSchema.parse(input.result))
    )
      throw Error('계략 패 입력을 재현하지 못했습니다.');
    return { ...replay, state: result.state };
  },
};
