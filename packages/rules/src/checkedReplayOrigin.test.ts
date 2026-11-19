import { expect, it } from 'vitest';
import { commandInitial } from '../test/commandFixture';
import { providedRuleData } from './providedRuleData';
import { checkedReplayOrigin, checkReplayOrigin, type RuleRegistry } from './ruleRegistry';
import type { WorldView } from './model/world';
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

it('AC-INT-04 shares an initial world only within one complete origin validation', () => {
  const seen: WorldView[] = [];
  const registry: RuleRegistry = {
    features: ['first', 'second'].map((key) => ({
      key,
      requires: [],
      conflicts: [],
      checkOrigin: ({ initialWorld }) => {
        seen.push(initialWorld!);
      },
    })),
    inputKinds: [],
  };
  const origin = { version: 3, initial: commandInitial(), initialStateHash: 'checked', resourceHash: 'checked' };
  checkReplayOrigin(origin, registry);
  checkReplayOrigin(origin, registry);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[2]).toBe(seen[3]);
  expect(seen[0]).not.toBe(seen[2]);
  expect(seen[0]!.generals[1]).not.toBe(origin.initial.generals[0]);
});
