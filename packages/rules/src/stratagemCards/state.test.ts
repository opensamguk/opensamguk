import { describe, expect, it, vi } from 'vitest';
import { createRng } from '@opensamguk/shared';
import * as shared from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { stratagemCardsConfigSchema } from './config';
import { drawStratagemCard, initialStratagemCards, readStratagemCardsState, reconcileStratagemCards } from './state';
import { settleStratagemCards } from './monthly';
import { TEST_STRATAGEM_CARDS_CONFIG } from './testFixture';

const setup = () => {
  const world = commandWorld(),
    state = initialStratagemCards(TEST_STRATAGEM_CARDS_CONFIG, world, 'card-fixture'),
    nationId = Number(Object.keys(world.nations)[0]),
    city = Object.values(world.cities).find((city) => city.nationId === nationId)!;
  return { world, state, nationId, city };
};

describe('AC-P2-23 계략 패 상태와 월간 보충', () => {
  it.each([
    { capacity: 4 },
    { deck: [] },
    { deck: [{ kind: 'trap', weight: 0 }] },
    {
      deck: [
        { kind: 'trap', weight: 1 },
        { kind: 'trap', weight: 2 },
      ],
    },
    { trap: { lossBp: 10_001, atmosLoss: 10 } },
    { startHand: 4 },
    { trapExpiryMonths: 0 },
    { unexpected: true },
  ])('잘못된 명시 config %j를 거부한다', (change) => {
    expect(stratagemCardsConfigSchema.safeParse({ ...TEST_STRATAGEM_CARDS_CONFIG, ...change }).success).toBe(false);
  });

  it.each([
    [0, 'fire_attack'],
    [1, 'trap'],
    [2, 'trap'],
  ] as const)('가중 경계 %s는 %s다', (index, kind) => {
    const config = {
        ...TEST_STRATAGEM_CARDS_CONFIG,
        deck: [
          { kind: 'fire_attack' as const, weight: 1 },
          { kind: 'trap' as const, weight: 2 },
        ],
      },
      rng = createRng('unused'),
      int = vi.spyOn(rng, 'int').mockReturnValue(index);
    expect(drawStratagemCard(config, rng)).toBe(kind);
    expect(int).toHaveBeenCalledExactlyOnceWith(0, 2);
  });

  it('시작 패는 명시한 수만큼만 뽑고 config·원본 세계를 바꾸지 않는다', () => {
    const { world } = setup(),
      before = structuredClone(world),
      config = { ...TEST_STRATAGEM_CARDS_CONFIG, startHand: 3 },
      first = initialStratagemCards(config, world, 'same-seed');
    expect(Object.values(first.nations).every((cards) => cards.hand.length === 3)).toBe(true);
    expect(first).toEqual(initialStratagemCards(config, world, 'same-seed'));
    first.config.deck[0]!.weight = 99;
    expect(config.deck[0]!.weight).toBe(1);
    expect(world).toEqual(before);
  });

  it('월마다 국가당 한 장, 세 장 뒤 멈추며 같은 달을 중복 보충하지 않는다', () => {
    const { world, state } = setup(),
      before = structuredClone(state);
    let current = state;
    for (let month = 1; month <= 4; month++) {
      const result = settleStratagemCards(world, current, month * TICKS_PER_MONTH);
      expect(result.draws).toHaveLength(month <= 3 ? Object.keys(world.nations).length : 0);
      expect(Object.values(result.state.nations).every((cards) => cards.hand.length === Math.min(month, 3))).toBe(true);
      expect(settleStratagemCards(world, result.state, month * TICKS_PER_MONTH)).toEqual({
        state: result.state,
        draws: [],
      });
      current = result.state;
    }
    expect(state).toEqual(before);
  });

  it('같은 시드·월은 고정한 패 기록과 같다', () => {
    const { world, state } = setup(),
      first = settleStratagemCards(world, state, TICKS_PER_MONTH);
    expect(first.draws).toEqual([
      { nationId: 1, kind: 'incite' },
      { nationId: 2, kind: 'incite' },
    ]);
    expect(settleStratagemCards(world, structuredClone(state), TICKS_PER_MONTH)).toEqual(first);
  });

  it('찬 국가는 RNG를 쓰지 않고 빈 국가만 한 번 쓴다', () => {
    const { world, state } = setup(),
      ids = Object.keys(state.nations)
        .map(Number)
        .sort((a, b) => a - b),
      last = ids.at(-1)!,
      rng = createRng('count-draws'),
      int = vi.spyOn(rng, 'int'),
      factory = vi.spyOn(shared, 'rngFor').mockReturnValue(rng);
    try {
      for (const id of ids) state.nations[id]!.hand = id === last ? ['trap', 'trap'] : ['trap', 'trap', 'trap'];
      const first = settleStratagemCards(world, state, TICKS_PER_MONTH);
      expect(first.draws.map((draw) => draw.nationId)).toEqual([last]);
      expect(int).toHaveBeenCalledExactlyOnceWith(0, 4);
      expect(factory).toHaveBeenCalledExactlyOnceWith(state.seed, 'stratagem-cards-v1', 'monthly', TICKS_PER_MONTH);
      int.mockClear();
      expect(settleStratagemCards(world, first.state, 2 * TICKS_PER_MONTH).draws).toEqual([]);
      expect(int).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
    }
  });

  it('설치한 함정이 포함된 세 칸에는 보충하지 않고 거점을 잃으면 정리와 보충을 함께 한다', () => {
    const { world, state, nationId, city } = setup();
    state.nations[nationId] = { hand: ['fire_attack', 'incite'], traps: [{ cityKey: city.cityKey, setTick: 0 }] };
    const full = settleStratagemCards(world, state, TICKS_PER_MONTH);
    expect(full.draws.some((draw) => draw.nationId === nationId)).toBe(false);
    world.cities[city.cityKey]!.nationId = null;
    expect(() => readStratagemCardsState(full.state, world)).toThrow('소유');
    const lost = settleStratagemCards(world, full.state, 2 * TICKS_PER_MONTH);
    expect(lost.state.nations[nationId]!.traps).toEqual([]);
    expect(lost.state.nations[nationId]!.hand).toHaveLength(3);
    expect(lost.draws.filter((draw) => draw.nationId === nationId)).toHaveLength(1);
    expect(full.state.nations[nationId]!.traps).toHaveLength(1);
  });

  it('멸망 국가 패를 제거하고 새 국가에는 빈 패를 만든다. 정리는 멱등이다', () => {
    const { world, state, nationId } = setup(),
      nation = world.nations[nationId]!;
    delete world.nations[nationId];
    world.nations[100] = { ...nation, id: 100 };
    for (const city of Object.values(world.cities)) if (city.nationId === nationId) city.nationId = null;
    const clean = reconcileStratagemCards(world, state, 0);
    expect(clean.nations[nationId]).toBeUndefined();
    expect(clean.nations[100]).toEqual({ hand: [], traps: [] });
    expect(reconcileStratagemCards(world, clean, 0)).toEqual(clean);
  });

  it('명시한 함정 만료는 경계에서 적용하고 무기한 함정은 남긴다', () => {
    const { world, state, nationId, city } = setup();
    state.nations[nationId]!.traps = [{ cityKey: city.cityKey, setTick: 0 }];
    const finite = structuredClone(state);
    finite.config.trapExpiryMonths = 1;
    expect(reconcileStratagemCards(world, finite, TICKS_PER_MONTH - 1).nations[nationId]!.traps).toHaveLength(1);
    expect(reconcileStratagemCards(world, finite, TICKS_PER_MONTH).nations[nationId]!.traps).toEqual([]);
    expect(reconcileStratagemCards(world, state, TICKS_PER_MONTH).nations[nationId]!.traps).toHaveLength(1);
  });

  it('함정을 상한 밖으로 명시한 config는 손패 세 장과 설치 함정을 함께 허용한다', () => {
    const { world, state, nationId, city } = setup();
    state.config.trapCountsInCapacity = false;
    state.nations[nationId] = { hand: ['trap', 'trap'], traps: [{ cityKey: city.cityKey, setTick: 0 }] };
    const next = settleStratagemCards(world, state, TICKS_PER_MONTH).state;
    expect(next.nations[nationId]!.hand).toHaveLength(3);
    expect(next.nations[nationId]!.traps).toHaveLength(1);
    expect(readStratagemCardsState(next, world)).toEqual(next);
  });

  it('국가 항목 누락·남는 항목·함정 없는 덱의 설치 함정을 거부한다', () => {
    const { world, state, nationId, city } = setup(),
      missing = structuredClone(state),
      extra = structuredClone(state);
    delete missing.nations[nationId];
    expect(() => readStratagemCardsState(missing, world)).toThrow('국가');
    extra.nations[100] = { hand: [], traps: [] };
    expect(() => readStratagemCardsState(extra, world)).toThrow('국가');
    state.config.deck = state.config.deck.filter((card) => card.kind !== 'trap');
    state.nations[nationId]!.traps = [{ cityKey: city.cityKey, setTick: 0 }];
    expect(() => readStratagemCardsState(state, world)).toThrow('덱');
  });

  it('revision 한도 직전의 변경은 성공하고 한도에서 멈춘다', () => {
    const { world, state } = setup();
    state.revision = 2_147_483_646;
    const next = settleStratagemCards(world, state, TICKS_PER_MONTH).state;
    expect(next.revision).toBe(2_147_483_647);
    expect(() => settleStratagemCards(world, next, 2 * TICKS_PER_MONTH)).toThrow('한도');
  });

  it('저장된 월을 벗어난 함정 설치 시각을 거부한다', () => {
    const { world, state, nationId, city } = setup();
    state.nations[nationId]!.traps = [{ cityKey: city.cityKey, setTick: TICKS_PER_MONTH }];
    expect(() => readStratagemCardsState(state, world)).toThrow('저장된 월');
    state.nations[nationId]!.traps[0]!.setTick = TICKS_PER_MONTH - 1;
    expect(readStratagemCardsState(state, world)).toEqual(state);
  });

  it('덱 밖 패·중복 함정·보유 상한 초과를 거부한다', () => {
    const { world, state, nationId, city } = setup();
    state.nations[nationId]!.hand = ['nation_raid'];
    expect(() => readStratagemCardsState(state, world)).toThrow('덱');
    state.nations[nationId] = {
      hand: [],
      traps: [
        { cityKey: city.cityKey, setTick: 0 },
        { cityKey: city.cityKey, setTick: 0 },
      ],
    };
    expect(() => readStratagemCardsState(state, world)).toThrow('겹칩니다');
    state.nations[nationId] = { hand: ['trap', 'trap', 'trap'], traps: [{ cityKey: city.cityKey, setTick: 0 }] };
    expect(() => readStratagemCardsState(state, world)).toThrow('상한');
  });

  it('과거·소수 정산 시각과 revision 넘침을 거부하고 입력은 보존한다', () => {
    const { world, state } = setup(),
      settled = settleStratagemCards(world, state, TICKS_PER_MONTH).state;
    expect(() => settleStratagemCards(world, settled, 0)).toThrow('되돌아');
    expect(() => settleStratagemCards(world, settled, TICKS_PER_MONTH + 0.5)).toThrow();
    expect(() => settleStratagemCards(world, state, 2 * TICKS_PER_MONTH)).toThrow('한 달씩');
    state.revision = 2_147_483_647;
    const before = structuredClone(state);
    expect(() => settleStratagemCards(world, state, TICKS_PER_MONTH)).toThrow('한도');
    expect(state).toEqual(before);
  });
});
