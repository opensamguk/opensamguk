import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import type { WorldState } from '../model/world';
import { applyEffects } from './effects';
import { attack } from './attack';
import { runCommand } from './registry';
import { verifySuccess, verifyFailure } from './contracts';

describe('attack', () => {
  it('성공', () => verifySuccess('attack'));
  it('실패', () => verifyFailure('attack'));
});

describe('AC-M2-19 전투 전공', () => {
  const actor = { generalId: 1, tick: 100, unitSet: testUnits };
  const execute = (state: WorldState) => attack.execute(state, actor, { cityKey: 2 }, rngFor('battle-awards'));

  it('야전 상대마다 승리 1회, 도시 점령은 별도로 1회를 기록한다', () => {
    const state = commandWorld();
    const before = structuredClone(state);
    const result = execute(state);
    expect(result.battleAwards).toEqual([
      { generalId: 1, wins: 1, captures: 0 },
      { generalId: 1, wins: 1, captures: 0 },
      { generalId: 1, wins: 0, captures: 1 },
    ]);
    const after = applyEffects(state, result.effects);
    expect(after.cities[2]!.nationId).toBe(1);
    expect(after.generals[2]!.crew).toBe(0);
    expect(after.generals[3]!.crew).toBe(0);
    expect(after.generals[1]).not.toHaveProperty('wins');
    expect(after.generals[1]).not.toHaveProperty('captures');
    expect(state).toEqual(before);
  });

  it('공격군을 격파하면 수비 장수에게 승리를 기록한다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 20;
    state.generals[2]!.crew = 10000;
    const result = execute(state);
    expect(result.battleAwards).toEqual([{ generalId: 2, wins: 1, captures: 0 }]);
    const after = applyEffects(state, result.effects);
    expect(after.generals[1]!.crew).toBe(0);
    expect(after.cities[2]!.nationId).toBe(2);
  });

  it('수비군 병력이 남아도 사기가 소진되면 공격군 승리다', () => {
    const state = commandWorld();
    state.generals[2]!.crew = 10000;
    state.generals[2]!.atmos = 20;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    expect(after.generals[2]!.crew).toBeGreaterThan(0);
    expect(after.generals[2]!.atmos).toBe(0);
    expect(result.battleAwards).toContainEqual({ generalId: 1, wins: 1, captures: 0 });
  });

  it('양쪽이 살아서 교전을 마치면 승리를 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[2]!.crew = 10000;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    for (const id of [1, 2]) {
      expect(after.generals[id]!.crew).toBeGreaterThan(0);
      expect(after.generals[id]!.atmos).toBeGreaterThan(0);
    }
    expect(result.battleAwards).toEqual([]);
  });

  it('양쪽 사기가 동시에 소진되면 승리를 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[1]!.atmos = 50;
    state.generals[2]!.crew = 10000;
    state.generals[2]!.atmos = 50;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    expect(after.generals[1]!.atmos).toBe(0);
    expect(after.generals[2]!.atmos).toBe(0);
    expect(result.battleAwards).toEqual([]);
  });

  it('양쪽 병력이 동시에 소진되면 승리를 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 1;
    state.generals[2]!.crew = 1;
    state.generals[3]!.crew = 0;
    const result = execute(state);
    const after = applyEffects(state, result.effects);
    expect(after.generals[1]!.crew).toBe(0);
    expect(after.generals[2]!.crew).toBe(0);
    expect(result.battleAwards).toEqual([]);
  });

  it.each([0, 10])('수비군 없이 성벽 %i인 도시를 점령하면 점령만 기록한다', (wall) => {
    const state = commandWorld();
    state.generals[2]!.crew = 0;
    state.generals[3]!.crew = 0;
    state.cities[2]!.wall = wall;
    const result = execute(state);
    expect(applyEffects(state, result.effects).cities[2]!.nationId).toBe(1);
    expect(result.battleAwards).toEqual([{ generalId: 1, wins: 0, captures: 1 }]);
  });

  it('성벽 공격만 하다 패하면 승리와 점령을 기록하지 않는다', () => {
    const state = commandWorld();
    state.generals[1]!.crew = 20;
    state.generals[2]!.crew = 0;
    state.generals[3]!.crew = 0;
    state.cities[2]!.wall = 10000;
    const result = execute(state);
    expect(result.battleAwards).toEqual([]);
    expect(applyEffects(state, result.effects).cities[2]!.nationId).toBe(2);
  });

  it('검사를 통과하지 못한 출병은 전공을 내보내지 않는다', () => {
    const state = commandWorld();
    state.diplomacies = [];
    const before = structuredClone(state);
    const result = runCommand(state, actor, 'attack', { cityKey: 2 }, rngFor('rejected-battle'));
    expect(result).toMatchObject({ code: 'NOT_WAR' });
    expect(result).not.toHaveProperty('battleAwards');
    expect(state).toEqual(before);
  });
});
