import { describe, expect, it } from 'vitest';
import { rngFor } from '../packages/shared/src/index';
import { campaignAttack, tacticalBattleReports } from '../packages/rules/src/campaign/attack';
import { tacticalFixture, testUnits } from '../packages/rules/test/tacticalFixture';
import { settleTacticalBattle } from '../packages/rules/src/tactical/world';

describe('AC-INT-09 전술 공격 보고 연결', () => {
  it('작전 회의를 열 때 실제 수비국을 알리고 정산 전 전공은 만들지 않는다', () => {
    const { world } = tacticalFixture();
    world.campaign!.tactical!.battles = [];
    world.cityResources!.cities['1']!.rice = 1_000_000;
    const result = campaignAttack.execute(
      world,
      { generalId: 1, tick: 100, unitSet: testUnits },
      { cityKey: 2 },
      rngFor('report'),
    );
    expect(result.attackTarget).toEqual({ cityKey: 2, defendingNationId: 2 });
    expect(result.battleAwards).toBeUndefined();
  });
  it('새로 정산된 승리만 수비 보고·점령·전공·멸망 기록을 반환한다', () => {
    const { world, battle } = tacticalFixture();
    const before = structuredClone(world);
    battle.phase = 'ended';
    battle.result = 'attack';
    battle.units.find((u) => u.side === 'defend')!.troops = 0;
    settleTacticalBattle(world, battle, 100);
    const result = tacticalBattleReports(before, world, battle.id, 100);
    expect(result.reports).toMatchObject([{ generalId: 2, text: expect.stringContaining('점령') }]);
    expect(result.battleAwards).toContainEqual({ generalId: 1, wins: 0, captures: 1 });
    expect(result.battleAwards).toContainEqual({ generalId: 1, wins: 1, captures: 0 });
    expect(result.history).toContainEqual({ nationId: 2, text: expect.stringContaining('멸망') });
    expect(tacticalBattleReports(world, world, battle.id, 100).reports).toEqual([]);
  });
});
