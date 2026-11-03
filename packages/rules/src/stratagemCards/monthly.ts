import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cardQuantity, type CardKind } from './config';
import {
  drawStratagemCard,
  incrementCardsRevision,
  readStratagemCardsState,
  reconcileStratagemCards,
  type CardWorld,
} from './state';

export function settleStratagemCards(world: CardWorld, value: unknown, tick: number) {
  cardQuantity.multipleOf(TICKS_PER_MONTH).parse(tick);
  const state = reconcileStratagemCards(world, value, tick),
    draws: { nationId: number; kind: CardKind }[] = [];
  if (tick < state.monthlyTick) throw Error('계략 패 정산 시각이 되돌아갔습니다.');
  if (tick === state.monthlyTick) return { state, draws };
  if (tick !== state.monthlyTick + TICKS_PER_MONTH) throw Error('계략 패 정산은 한 달씩 진행해야 합니다.');
  const rng = rngFor(state.seed, 'stratagem-cards-v1', 'monthly', tick);
  for (const id of Object.keys(state.nations)
    .map(Number)
    .sort((a, b) => a - b)) {
    const cards = state.nations[id]!;
    if (cards.hand.length + (state.config.trapCountsInCapacity ? cards.traps.length : 0) >= state.config.capacity)
      continue;
    const kind = drawStratagemCard(state.config, rng);
    cards.hand.push(kind);
    draws.push({ nationId: id, kind });
  }
  state.monthlyTick = tick;
  incrementCardsRevision(state);
  return { state: readStratagemCardsState(state, world), draws };
}
