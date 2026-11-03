import { z } from 'zod';
import { rngFor, type Rng } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';
import { cardId, cardKindSchema, cardQuantity, stratagemCardsConfigSchema, type StratagemCardsConfig } from './config';

export const stratagemCardsStateSchema = z.strictObject({
  version: z.literal(1),
  seed: z.string().min(1).max(1024),
  config: stratagemCardsConfigSchema,
  monthlyTick: cardQuantity.multipleOf(TICKS_PER_MONTH),
  revision: cardQuantity,
  nations: z
    .record(
      z.string().regex(/^[1-9]\d*$/),
      z.strictObject({
        hand: z.array(cardKindSchema).max(3),
        traps: z.array(z.strictObject({ cityKey: cardId, setTick: cardQuantity })).max(10_000),
      }),
    )
    .refine((nations) => Object.keys(nations).length <= 10_000),
});
export type StratagemCardsState = z.infer<typeof stratagemCardsStateSchema>;
export type CardWorld = Pick<WorldView, 'nations' | 'cities'>;

export function drawStratagemCard(config: StratagemCardsConfig, rng: Rng) {
  let index = rng.int(0, config.deck.reduce((total, card) => total + card.weight, 0) - 1);
  for (const card of config.deck) {
    if (index < card.weight) return card.kind;
    index -= card.weight;
  }
  throw Error('패 뽑기 범위를 확인하세요.');
}

export function incrementCardsRevision(state: StratagemCardsState) {
  if (state.revision === 2_147_483_647) throw Error('계략 패 변경 번호 한도를 넘었습니다.');
  state.revision++;
}

export function readStratagemCardsState(value: unknown, world: CardWorld) {
  const state = stratagemCardsStateSchema.parse(value),
    kinds = new Set(state.config.deck.map((card) => card.kind));
  const nationIds = Object.keys(world.nations)
    .map(Number)
    .sort((a, b) => a - b);
  if (nationIds.length !== Object.keys(state.nations).length) throw Error('계략 패 국가 목록을 확인하세요.');
  for (const id of nationIds) {
    const cards = state.nations[id];
    if (!cards) throw Error('국가의 계략 패가 없습니다.');
    if (cards.hand.some((kind) => !kinds.has(kind)) || (cards.traps.length && !kinds.has('trap')))
      throw Error('덱에 없는 계략 패가 있습니다.');
    if (cards.hand.length + (state.config.trapCountsInCapacity ? cards.traps.length : 0) > state.config.capacity)
      throw Error('계략 패 보유 상한을 넘었습니다.');
    if (new Set(cards.traps.map((trap) => trap.cityKey)).size !== cards.traps.length)
      throw Error('같은 도시에 함정이 겹칩니다.');
    for (const trap of cards.traps)
      if (world.cities[trap.cityKey]?.nationId !== id) throw Error('현재 소유 도시의 함정이 아닙니다.');
  }
  return state;
}

export function initialStratagemCards(config: unknown, world: CardWorld, seed: string): StratagemCardsState {
  const parsed = stratagemCardsConfigSchema.parse(config),
    rng = rngFor(seed, 'stratagem-cards-v1', 'initial');
  return readStratagemCardsState(
    {
      version: 1,
      seed,
      config: parsed,
      monthlyTick: 0,
      revision: 0,
      nations: Object.fromEntries(
        Object.keys(world.nations)
          .map(Number)
          .sort((a, b) => a - b)
          .map((id) => [
            id,
            {
              hand: Array.from({ length: parsed.startHand }, () => drawStratagemCard(parsed, rng)),
              traps: [],
            },
          ]),
      ),
    },
    world,
  );
}

// 소유 변화 직후에는 구조를 먼저 읽고 정리한 뒤 엄격한 세계 관계 검사를 한다.
export function reconcileStratagemCards(world: CardWorld, value: unknown, tick: number) {
  cardQuantity.parse(tick);
  const state = stratagemCardsStateSchema.parse(value);
  let changed = false;
  for (const id of Object.keys(state.nations))
    if (!world.nations[Number(id)]) {
      delete state.nations[id];
      changed = true;
    }
  for (const id of Object.keys(world.nations)
    .map(Number)
    .sort((a, b) => a - b)) {
    const cards = state.nations[id];
    if (!cards) {
      state.nations[id] = { hand: [], traps: [] };
      changed = true;
      continue;
    }
    const traps = cards.traps.filter(
      (trap) =>
        world.cities[trap.cityKey]?.nationId === id &&
        (state.config.trapExpiryMonths === null ||
          tick < trap.setTick + state.config.trapExpiryMonths * TICKS_PER_MONTH),
    );
    if (traps.length !== cards.traps.length) {
      cards.traps = traps;
      changed = true;
    }
  }
  if (changed) incrementCardsRevision(state);
  return readStratagemCardsState(state, world);
}
