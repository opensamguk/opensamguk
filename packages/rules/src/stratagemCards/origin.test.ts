import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { toWorldState } from '../model/world';
import { readStoredStratagemCards, readStratagemCardsStorage } from './origin';
import { initialStratagemCards, reconcileStratagemCards } from './state';
import { TEST_STRATAGEM_CARDS_CONFIG } from './testFixture';
import { stratagemCardsView } from './view';
import { decideStratagemCardsAction } from './actions';

function fixture() {
  const initial = commandInitial();
  initial.ruleFeatures = ['five-stats', 'personnel', 'stratagem-basic', 'stratagem-cards-v1'];
  const config = { ...TEST_STRATAGEM_CARDS_CONFIG, deck: [{ kind: 'trap' as const, weight: 1 }], startHand: 1 },
    state = toWorldState(initial),
    cards = initialStratagemCards(config, state, initial.seed);
  state.stratagemCards = cards;
  return {
    state,
    row: {
      replayFormat: 3,
      ruleFeatures: initial.ruleFeatures,
      monthlyTick: 0,
      replayOrigin: { version: 3, initial, featureData: { 'stratagem-cards-v1': { version: 1, config } } },
      stratagemCardsState: cards,
    },
  };
}

it('AC-P2-23 명시 원 설정·시드·월 시각의 저장 사본만 적재한다', () => {
  const { state, row } = fixture();
  expect(readStoredStratagemCards(row, state)).toEqual(state.stratagemCards);
  expect(readStratagemCardsStorage({ ...row, ruleFeatures: [], stratagemCardsState: null })).toBeUndefined();
  expect(() => readStratagemCardsStorage({ ...row, ruleFeatures: [] })).toThrow();
});

it.each([
  'format',
  'flags',
  'dependency',
  'fiveStats',
  'data',
  'state',
  'seed',
  'config',
  'monthlyTick',
  'unsupported',
])('AC-P2-23 저장된 %s 불일치를 기본값으로 덮지 않는다', (part) => {
  const { row } = fixture();
  if (part === 'format') row.replayFormat = 1;
  if (part === 'flags') row.replayOrigin.initial.ruleFeatures = ['personnel'];
  if (part === 'dependency' || part === 'fiveStats') {
    row.ruleFeatures = row.ruleFeatures.filter((key) => key !== (part === 'dependency' ? 'personnel' : 'five-stats'));
    row.replayOrigin.initial.ruleFeatures = [...row.ruleFeatures];
  }
  if (part === 'data') delete (row.replayOrigin.featureData as Record<string, unknown>)['stratagem-cards-v1'];
  if (part === 'state') row.stratagemCardsState = null as never;
  if (part === 'seed') row.stratagemCardsState.seed += '-changed';
  if (part === 'config') row.stratagemCardsState.config.trap.lossBp++;
  if (part === 'monthlyTick') row.monthlyTick = 10_000;
  if (part === 'unsupported') row.replayOrigin.featureData['stratagem-cards-v1'].config.setter = 'chiefs';
  expect(() => readStratagemCardsStorage(row)).toThrow();
});

it('AC-P2-23 소유 변경은 구조 검사 뒤 정리하되 일반 적재에서는 거부한다', () => {
  const { state, row } = fixture(),
    result = decideStratagemCardsAction(state, 1, { type: 'trap.set', nationId: 1, cityKey: 1 }, 0);
  if (!result.ok) throw Error(result.message);
  row.stratagemCardsState = result.state.stratagemCards!;
  result.state.cities[1]!.nationId = 2;
  expect(() => readStoredStratagemCards(row, result.state)).toThrow();
  const original = readStratagemCardsStorage(row)!;
  const repaired = reconcileStratagemCards(result.state, original, row.monthlyTick);
  expect(repaired.nations[1]!.traps).toEqual([]);
  expect(repaired.revision).toBe(original.revision + 1);
  expect(reconcileStratagemCards(result.state, repaired, row.monthlyTick)).toEqual(repaired);
});

it('AC-P2-23 조회는 자기 국가의 복사본만 주고 재야·미참가자에게 패를 주지 않는다', () => {
  const { state } = fixture();
  state.stratagemCards!.nations[2]!.hand = [];
  const own = stratagemCardsView(state, 1, 0),
    foreign = stratagemCardsView(state, 2, 0);
  expect(own.hand).toEqual(['trap']);
  expect(own.mine).toMatchObject({ generalId: 1, nationId: 1, canSetTrap: true });
  expect(foreign.hand).toEqual([]);
  expect(stratagemCardsView(state, null, 0).mine).toBeNull();
  expect(stratagemCardsView(state, 4, 0).hand).toEqual([]);
  expect(JSON.stringify(own)).not.toContain(state.stratagemCards!.seed);
  own.hand.pop();
  expect(state.stratagemCards!.nations[1]!.hand).toEqual(['trap']);
});
