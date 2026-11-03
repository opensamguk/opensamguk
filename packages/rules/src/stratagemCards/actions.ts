import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { governanceMonarchs } from '../governance/realm';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { cardId, cardQuantity } from './config';
import { incrementCardsRevision, readStratagemCardsState } from './state';

export const stratagemCardsInputSchema = z.strictObject({
  type: z.literal('trap.set'),
  nationId: cardId,
  cityKey: cardId,
});
export type StratagemCardsInput = z.infer<typeof stratagemCardsInputSchema>;
const deny = (code: string, message: string) => ({ ok: false as const, code, message });

// 세션·제재·행위자 고정은 호출 경계에서 다시 검사한다. 여기서는 현재 게임 권한을 검사한다.
export function decideStratagemCardsAction(world: WorldView, actorId: number, payload: unknown, tick: number) {
  if (!world.ruleFeatures?.includes('stratagem-cards-v1'))
    return deny('FEATURE_DISABLED', '계략 패 기능을 켜지 않은 월드입니다.');
  const cards = readStratagemCardsState(world.stratagemCards, world),
    actor = world.generals[actorId];
  if (!cardQuantity.safeParse(tick).success || tick < cards.monthlyTick || tick >= cards.monthlyTick + TICKS_PER_MONTH)
    return deny('BAD_TICK', '현재 월의 입력이 아닙니다.');
  if (!actor || actor.activeFromYear > world.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH)))
    return deny('NO_GENERAL', '등장한 장수가 없습니다.');
  const parsed = stratagemCardsInputSchema.safeParse(payload);
  if (!parsed.success) return deny('BAD_ARGS', '함정 설치 인자를 확인하세요.');
  const { nationId, cityKey } = parsed.data;
  if (actor.nationId !== nationId || !world.nations[nationId])
    return deny('NATION_CHANGED', '소속 국가가 바뀌었습니다.');
  if (cards.config.setter !== 'ruler') throw Error('수뇌 함정 설치 규칙은 아직 지원하지 않습니다.');
  if (governanceMonarchs(world, tick).get(nationId) !== actorId)
    return deny('FORBIDDEN', '군주만 함정을 설치할 수 있습니다.');
  const hand = cards.nations[nationId]!.hand,
    cardIndex = hand.indexOf('trap');
  if (cardIndex < 0) return deny('NO_TRAP_CARD', '함정 패가 없습니다.');
  if (world.cities[cityKey]?.nationId !== nationId)
    return deny('BAD_CITY', '자기 국가 거점에만 함정을 설치할 수 있습니다.');
  if (cards.nations[nationId]!.traps.some((trap) => trap.cityKey === cityKey))
    return deny('TRAP_EXISTS', '이미 함정이 있는 거점입니다.');
  if (cards.revision === 2_147_483_647) return deny('LIMIT', '계략 패 변경 번호 한도에 닿았습니다.');
  const state = cloneWorld(world);
  hand.splice(cardIndex, 1);
  cards.nations[nationId]!.traps.push({ cityKey, setTick: tick });
  incrementCardsRevision(cards);
  state.stratagemCards = readStratagemCardsState(cards, state);
  return { ok: true as const, state, result: { action: 'trap.set' as const, revision: cards.revision, tick } };
}
