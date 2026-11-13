import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { RESEARCH_ERA_FEATURE, researchEra } from '../nationResearch/era';
import { runGeneralTurn } from './turn';
import { verifySuccess, verifyFailure } from './contracts';

describe('research', () => {
  it('성공', () => verifySuccess('research'));
  it('실패', () => verifyFailure('research'));

  it('현재 등급 이상은 기술 연구 효과를 줄이고 5년 뒤 기준을 높인다', () => {
    const world = commandWorld();
    world.ruleFeatures = [RESEARCH_ERA_FEATURE];
    world.nations[1]!.tech = 1000;
    world.generals[1]!.userId = 'researcher';
    const gain = (tick: number) =>
      runGeneralTurn(world, { generalId: 1, tick }, { commandKey: 'research', args: {} }, 'era').state.nations[1]!
        .tech - 1000;
    const old = structuredClone(world);
    delete old.ruleFeatures;
    const normal =
      runGeneralTurn(old, { generalId: 1, tick: 0 }, { commandKey: 'research', args: {} }, 'era').state.nations[1]!
        .tech - 1000;
    expect(normal).toBeGreaterThan(0);
    expect(gain(0)).toBeCloseTo(normal / 4, 0);
    expect(researchEra(world.startYear, world.startYear)).toEqual({
      level: 1,
      threshold: 1000,
      nextYear: world.startYear + 5,
    });
    expect(researchEra(world.startYear, world.startYear + 5).threshold).toBe(2000);
    expect(gain(60 * TICKS_PER_MONTH)).toBeGreaterThan(0);
  });
});
