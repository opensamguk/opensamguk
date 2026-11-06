import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRng } from '../../packages/shared/src/rng';
import { simulateBattle } from '../../packages/rules/src/battle/simulate';
import { unitSetSchema, type UnitSetResource } from '../../packages/rules/src/world/resources';

type Unit = UnitSetResource['crewTypes'][number];
const budget = 100_000;
const initialCrew = (unit: Unit) => {
  if (!(unit.cost > 0)) throw Error(`균형 검사에는 양의 병종 비용이 필요합니다: ${unit.id}`);
  return Math.round(budget / unit.cost);
};
const force = (unit: Unit, crew = initialCrew(unit)) => ({ crew, crewType: unit.id, train: 80, atmos: 80 });
export function measurePair(unitSet: UnitSetResource, a: Unit, b: Unit) {
  const first = force(a),
    second = force(b);
  let aWins = 0,
    bWins = 0,
    draws = 0;
  for (let index = 0; index < 100; index++)
    for (const swap of [false, true]) {
      const result = simulateBattle(
        {
          attacker: swap ? second : first,
          defender: swap ? first : second,
          attackerTech: 0,
          defenderTech: 0,
          defence: 0,
          unitSet,
          coefMode: 'multiply',
        },
        createRng(`balance-${index}`),
      );
      const left = (swap ? result.defender : result.attacker).crew * second.crew;
      const right = (swap ? result.attacker : result.defender).crew * first.crew;
      if (left > right) aWins++;
      else if (left < right) bWins++;
      else draws++;
    }
  return { a: a.id, b: b.id, aWins, bWins, draws, trials: 200 };
}
const tier = (unit: Unit) =>
  Math.max(0, ...(unit.requirements ?? []).flatMap((rule) => (rule.kind === 'tech' ? [rule.min] : [])));

export function measureWallDamage(unitSet: UnitSetResource, unit: Unit) {
  const wall = unitSet.crewTypes.find((row) => row.id === 1000);
  if (!wall) throw Error('성벽 병종이 없습니다.');
  // 피해가 병력 상한에서 같아지지 않도록 큰 고정 성벽에 같은 금 예산으로 비교한다.
  const wallCrew = 100_000;
  let damage = 0;
  for (let index = 0; index < 100; index++) {
    const result = simulateBattle(
      {
        attacker: force(unit),
        defender: force(wall, wallCrew),
        attackerTech: 0,
        defenderTech: 0,
        defence: 0,
        unitSet,
        coefMode: 'multiply',
      },
      createRng(`balance-${index}`),
    );
    damage += wallCrew - result.defender.crew;
  }
  return damage / 100;
}

export function measureBalance(unitSet: UnitSetResource) {
  if (unitSet.coefMode !== 'multiply') throw Error('원작식 확장 병종만 균형 검사합니다.');
  const units = unitSet.crewTypes.filter((unit) => unit.armType !== 0);
  const pairs: ReturnType<typeof measurePair>[] = [];
  for (let left = 0; left < units.length; left++)
    for (let right = left + 1; right < units.length; right++)
      pairs.push(measurePair(unitSet, units[left]!, units[right]!));
  const winRate = (a: number, b: number) => {
    const pair = pairs.find((row) => (row.a === a && row.b === b) || (row.a === b && row.b === a));
    if (!pair) throw Error(`균형 검사 쌍이 없습니다: ${a}/${b}`);
    return ((pair.a === a ? pair.aWins : pair.bWins) / pair.trials) * 100;
  };
  const checks: { key: string; pass: boolean; detail: unknown }[] = [];
  for (const [a, b] of [
    [1100, 1200],
    [1200, 1300],
    [1200, 1400],
    [1300, 1100],
    [1400, 1300],
  ] as const) {
    const rate = winRate(a, b);
    checks.push({ key: `advantage:${a}/${b}`, pass: rate >= 55, detail: { winRate: rate, min: 55 } });
  }
  const neutral = winRate(1100, 1400);
  checks.push({ key: 'neutral:1100/1400', pass: neutral >= 40 && neutral <= 60, detail: { winRate: neutral } });
  for (const unit of units) {
    const opponents = units.filter((other) => other.id !== unit.id && tier(other) >= tier(unit));
    const dominant = opponents.length > 0 && opponents.every((other) => winRate(unit.id, other.id) > 60);
    checks.push({ key: `dominance:${unit.id}`, pass: !dominant, detail: { tier: tier(unit) } });
  }
  const wallLoss = (unit: Unit) => measureWallDamage(unitSet, unit);
  const basicDamage = Math.max(...units.filter((unit) => [1100, 1200, 1300, 1400].includes(unit.id)).map(wallLoss));
  const siege = units
    .filter((unit) => unit.armType === 5)
    .map((unit) => ({ id: unit.id, name: unit.name, wallDamage: wallLoss(unit), basicDamage }));
  for (const row of siege) checks.push({ key: `siege:${row.id}`, pass: row.wallDamage > basicDamage, detail: row });
  return {
    budget,
    seeds: 100,
    orientations: 2,
    units: units.map((unit) => ({ id: unit.id, name: unit.name, tier: tier(unit), cost: unit.cost })),
    pairs,
    siege,
    checks,
    pass: checks.every((check) => check.pass),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2] ?? 'resources/unitset/expanded.json';
  const result = measureBalance(unitSetSchema.parse(JSON.parse(await readFile(source, 'utf8'))));
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}
