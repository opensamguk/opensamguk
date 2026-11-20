import { describe, expect, it } from 'vitest';
import { tacticalFixture, testUnits } from '../../test/tacticalFixture';
import { applyCityResourceInput } from '../cityResources/input';
import { closeCouncil, resolveBattleTurn } from './battle';
import { openTacticalBattle, settleTacticalBattle } from './world';

function defenseFixture(capital = true) {
  const { world } = tacticalFixture();
  delete world.campaign!.tactical;
  if (!capital) {
    world.cities[3]!.nationId = 2;
    world.nations[2]!.capitalCityKey = 3;
  }
  world.cityResources!.cities['2']!.rice = 10_000;
  world.cityResources!.cities['2']!.garrison = [{ crewType: 1100, troops: 100, train: 100, atmos: 100 }];
  return world;
}

function finishDefense(world: ReturnType<typeof defenseFixture>, moveDefender = false) {
  let battle = openTacticalBattle(
    world,
    101,
    world.campaign!.units.slice(0, 1),
    world.campaign!.units.slice(1),
    2,
    testUnits,
  );
  closeCouncil(battle);
  for (let turn = 0; turn < 30 && battle.phase !== 'ended'; turn++)
    battle = resolveBattleTurn(
      battle,
      battle.units.map((u) => ({
        unitId: u.id,
        action:
          moveDefender && turn === 0 && u.sourceId === 2
            ? { kind: 'move' as const, x: u.x - 1, y: u.y }
            : { kind: 'hold' as const },
      })),
      testUnits,
    );
  expect(battle).toMatchObject({ phase: 'ended', result: 'defend' });
  world.campaign!.tactical!.battles = [battle];
  const riceBeforeSettlement = world.cityResources!.cities['2']!.rice;
  const returnedRice = battle.sides.defend.riceOwners
    .filter((owner) => owner.kind === 'city')
    .reduce((sum, owner) => sum + owner.remaining, 0);
  settleTacticalBattle(world, battle);
  // 수비 SP 적재분은 기존처럼 환급하지 않고, 별도 군량의 잔량만 돌려준다.
  expect(world.cityResources!.cities['2']!.rice).toBe(riceBeforeSettlement + returnedRice);
  return battle;
}

describe('AC-INT-28 / AC-INT-18A 수비 SP와 행군 보급 정산', () => {
  it.each([true, false])('수도 여부 %s: 수비 생존 부곡은 같은 도시에서 다시 배속받는다', (capital) => {
    const world = defenseFixture(capital);
    const battle = finishDefense(world);
    const defender = battle.units.find((u) => u.sourceId === 2)!;
    expect(defender.troops).toBeGreaterThan(0);
    expect(defender.loadedSp).toBe(100);
    const allocated = applyCityResourceInput(world, { cityKey: 2, unitId: 2, crewType: 1100, amount: 10 }, 2, {
      tick: 101,
      userId: 'defender',
      userActive: true,
      armyTypes: [1100],
    });
    expect(allocated).toMatchObject({ ok: true });
    if (!allocated.ok) throw new Error(allocated.message);
    expect(allocated.state.campaign!.units.find((u) => u.id === 2)!.troops).toBe(defender.troops + 10);
    expect(world.campaign!.units.find((u) => u.id === 2)).not.toHaveProperty('supply');
  });

  it('다른 도시에서 수비한 원정 부곡은 기존 행군 보급의 잔량만 갱신한다', () => {
    const world = defenseFixture(false);
    world.cityResources!.cities['2']!.garrison = [];
    const unit = world.campaign!.units[1]!;
    const supply = {
      feature: 'march-supply-v1' as const,
      unit: 'SP' as const,
      loaded: 80,
      remaining: 65,
      originCityKey: 3,
    };
    unit.supply = { ...supply };
    const battle = finishDefense(world, true);
    const defender = battle.units.find((u) => u.sourceId === unit.id)!;
    expect(defender.sp).toBeLessThan(supply.remaining);
    expect(defender.loadedSp).toBe(supply.loaded);
    expect(unit.supply).toEqual({ ...supply, remaining: defender.sp });
  });

  it('같은 초기 상태와 명령은 전투 기록과 정산 상태가 같다', () => {
    const world = defenseFixture();
    const reloaded = structuredClone(world);
    expect(finishDefense(world)).toEqual(finishDefense(reloaded));
    expect(world).toEqual(reloaded);
  });
});
