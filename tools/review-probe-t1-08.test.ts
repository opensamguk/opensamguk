// 리뷰 전용 탐침. 커밋 대상이 아니다.
import { describe, expect, it } from 'vitest';
import { rngFor } from '../packages/shared/src/rng';
import { commandWorld, testUnits } from '../packages/rules/test/commandFixture';
import { applyEffects, runCommand, runGeneralTurn, type WorldState } from '../packages/rules/src/index';
import map from '../resources/map/che.json';
import scenario from '../resources/scenario/1030.json';
import unitSet from '../resources/unitset/basic.json';
import statRules from '../resources/scenario/default.json';
import { buildInitialWorld } from '../packages/rules/src/index';

function attackOnce(state: WorldState, id: number, cityKey: number, tick: number) {
  const result = runCommand(
    state,
    { generalId: id, target: 'general', tick, unitSet: testUnits },
    'attack',
    { cityKey },
    rngFor('probe', tick, id),
  );
  return { result, state: 'code' in result ? state : applyEffects(state, result.effects) };
}

describe('PROBE 성벽·수비 실제 규모', () => {
  for (const [wall, defence] of [
    [10, 0],
    [1000, 0],
    [5000, 0],
    [1000, 1000],
    [5000, 5000],
  ] as const) {
    it(`wall ${wall} defence ${defence}: 수비 장수 없이 병력 10000 보병을 매번 채워 몇 번에 점령하나`, () => {
      let state = commandWorld();
      state.cities[2]!.wall = wall;
      state.cities[2]!.defence = defence;
      state.generals[2]!.crew = 0;
      state.generals[3]!.crew = 0;
      let lost = 0;
      let attempts = 0;
      for (; attempts < 200 && state.cities[2]!.nationId !== 1; attempts++) {
        const g = state.generals[1]!;
        Object.assign(g, { crew: 10000, train: 100, atmos: 100, rice: 100000, cityKey: 1 });
        const out = attackOnce(state, 1, 2, 100 + attempts);
        if ('code' in out.result) throw new Error(out.result.code);
        lost += 10000 - out.state.generals[1]!.crew;
        state = out.state;
      }
      console.log(
        `PROBE wall=${wall} defence=${defence} attempts=${attempts} captured=${state.cities[2]!.nationId === 1} wallLeft=${state.cities[2]!.wall} crewLost=${lost}`,
      );
      expect(attempts).toBeGreaterThan(0);
    });
  }
});

describe('PROBE 수도 함락', () => {
  it('수도만 잃은 국가의 남은 도시는 보급이 끊기고 출병·모병이 막힌다', () => {
    const state = commandWorld();
    state.cities[3]!.nationId = 2;
    state.cities[3]!.supplied = true;
    state.cities[2]!.wall = 0;
    state.generals[2]!.crew = 0;
    state.generals[3]!.cityKey = 3;
    state.generals[3]!.crew = 1000;
    const out = attackOnce(state, 1, 2, 100);
    if ('code' in out.result) throw new Error(out.result.code);
    const after = out.state;
    const recruit = runCommand(
      after,
      { generalId: 3, target: 'general', tick: 200, unitSet: testUnits },
      'recruit',
      { amount: 10, crewType: 1100 },
      rngFor('x'),
    );
    const counter = runCommand(
      after,
      { generalId: 3, target: 'general', tick: 200, unitSet: testUnits },
      'attack',
      { cityKey: 2 },
      rngFor('x'),
    );
    const stale = runCommand(
      after,
      { generalId: 2, target: 'general', tick: 200, unitSet: testUnits },
      'train',
      {},
      rngFor('x'),
    );
    console.log(
      `PROBE capital nation2=${JSON.stringify({
        exists: !!after.nations[2],
        capital: after.nations[2]?.capitalCityKey,
        city2: after.cities[2]!.nationId,
        city3supplied: after.cities[3]!.supplied,
        recruit: 'code' in recruit ? recruit.code : 'ok',
        counter: 'code' in counter ? counter.code : 'ok',
        gen2: { nation: after.generals[2]!.nationId, city: after.generals[2]!.cityKey },
        gen2train: 'code' in stale ? stale.code : 'ok',
      })}`,
    );
    expect(after.nations[2]).toBeDefined();
  });
});

describe('PROBE 결정성', () => {
  it('국가 예턴 포함 같은 시드 두 번은 같고 시드를 바꾸면 전투 결과가 달라진다', () => {
    const base = commandWorld();
    base.generals[2]!.crew = 3000;
    base.generals[3]!.crew = 0;
    base.cities[2]!.wall = 5000;
    base.nationTurns = {
      1: Array.from({ length: 30 }, (_, i) =>
        i === 0
          ? { commandKey: 'nation_reward', args: { generalId: 1, resource: 'gold', amount: 7 } }
          : { commandKey: 'nation_rest', args: {} },
      ),
    };
    const run = (seed: string) =>
      runGeneralTurn(
        structuredClone(base),
        { generalId: 1, tick: 100, unitSet: testUnits },
        { commandKey: 'attack', args: { cityKey: 2 } },
        seed,
      ).state;
    expect(run('s1')).toEqual(run('s1'));
    expect(run('s1')).not.toEqual(run('s2'));
  });
});

describe('PROBE 실제 시나리오 1030', () => {
  it('실제 도시 성벽·수비와 장수 통솔 분포', () => {
    const initial = buildInitialWorld({ map, scenario, unitSet, statRules, seed: 'probe' });
    const walls = initial.cities.map((c) => c.wall).sort((a, b) => a - b);
    const defences = initial.cities.map((c) => c.defence).sort((a, b) => a - b);
    const lead = initial.generals.map((g) => g.leadership).sort((a, b) => a - b);
    const crews = initial.generals.map((g) => g.crew).sort((a, b) => a - b);
    const q = (xs: number[]) => [xs[0], xs[Math.floor(xs.length / 2)], xs[xs.length - 1]];
    console.log(
      `PROBE scenario wall=${q(walls)} defence=${q(defences)} leadership=${q(lead)} crew=${q(crews)} nationTurns=${JSON.stringify(initial.nationTurns ?? null)}`,
    );
    expect(initial.cities.length).toBeGreaterThan(0);
  });
});
