import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { testUnits } from '../../packages/rules/test/commandFixture';
import { unitSetSchema } from '../../packages/rules/src/world/resources';
import { measureBalance, measurePair } from './balance';

it('AC-INT-22: 같은 조건에서 양 방향100시드씩 계산하며 무승부는 승리에 넣지 않는다', () => {
  const unitSet = unitSetSchema.parse(testUnits);
  const a = unitSet.crewTypes.find((unit) => unit.id === 1100)!;
  const b = unitSet.crewTypes.find((unit) => unit.id === 1200)!;
  for (const unit of [a, b]) {
    unit.attack = 0;
    unit.cost = 10;
    unit.attackCoef = [];
    unit.defenceCoef = [];
  }
  expect(measurePair(unitSet, a, b)).toEqual({ a: 1100, b: 1200, aWins: 0, bWins: 0, draws: 200, trials: 200 });
  expect(measurePair(unitSet, a, b)).toEqual(measurePair(unitSet, a, b));
  a.cost = 0;
  expect(() => measurePair(unitSet, a, b)).toThrow('양의 병종 비용');
});

it('게시할45종의946쌍189200전이 상성·중립·동급 독주·공성55기준을 모두 만족한다', () => {
  const source = readFileSync(new URL('../../resources/unitset/expanded.json', import.meta.url), 'utf8');
  const result = measureBalance(unitSetSchema.parse(JSON.parse(source)));
  expect(result.pairs).toHaveLength(946);
  expect(result.pairs.every((pair) => pair.aWins + pair.bWins + pair.draws === 200)).toBe(true);
  expect(result.checks).toHaveLength(55);
  expect(result.checks.filter((check) => !check.pass)).toEqual([]);
  expect(result.pass).toBe(true);
});
