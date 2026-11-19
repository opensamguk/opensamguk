import { expect, it } from 'vitest';
import { commandInitial } from '../test/commandFixture';
import { providedRuleData } from './providedRuleData';
import { checkedReplayOrigin } from './ruleRegistry';
import { readStoredNationResearch } from './nationResearch/origin';
import { initialNationResearch } from './nationResearch/state';
it('AC-M1-13 같은 생성 기록만 재사용하고 다른 사본과 파손된 현재 원장은 거부한다', () => {
  const initial = commandInitial();
  for (const general of initial.generals) {
    general.crew = 0;
    general.userId = null;
  }
  const origin = checkedReplayOrigin({
    version: 3,
    initial,
    initialStateHash: 'checked',
    resourceHash: 'checked',
    featureData: providedRuleData(initial, 60),
  });
  expect(checkedReplayOrigin(origin, origin)).toBe(origin);
  expect(() => checkedReplayOrigin(structuredClone(origin), origin)).toThrow('저장 행');
  const world = { replayFormat: 3, replayOrigin: origin, nationResearchState: initialNationResearch() };
  expect(readStoredNationResearch(world, origin)).toEqual(readStoredNationResearch(world));
  expect(() => readStoredNationResearch({ ...world, nationResearchState: null }, origin)).toThrow();
  expect(() => readStoredNationResearch({ ...world, replayFormat: 1 }, origin)).toThrow();
  const later = structuredClone(origin);
  checkedReplayOrigin(later);
  Object.assign(later, { version: 99 });
  expect(() => checkedReplayOrigin(later)).toThrow();
});
