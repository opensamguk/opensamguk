import { describe, expect, it } from 'vitest';
import { storedGeneralStats, generalStats, pledgeChance } from './fiveStats';
import { campaignPeople, readCampaignState } from '../campaign/state';
import { commandWorld } from '../../test/commandFixture';
import { withEquipmentBonus } from '../equipment/stats';
import { fightCampaignUnits } from '../campaign/skirmish';
import { testUnits } from '../../test/commandFixture';
import { rngFor } from '@opensamguk/shared';
import { stratagemAttackScore } from '../commands/ext/stratagem/base';

describe('AC-INT-28 세 능력 월드 회귀', () => {
  it('DB의 null 열을 제거하고 다섯 능력 월드의 누락·오염은 거부한다', () => {
    const base = { leadership: 60, strength: 50, intel: 40 };
    expect(storedGeneralStats({ ...base, politics: null, charm: null }, false)).toEqual(base);
    expect(storedGeneralStats(base, false)).toEqual(base);
    expect(() => storedGeneralStats({ ...base, politics: 20, charm: null }, false)).toThrow();
    expect(() => storedGeneralStats({ ...base, politics: null, charm: null }, true)).toThrow();
    expect(() => storedGeneralStats({ ...base, politics: 50 }, true)).toThrow();
  });
  it('조정이 사용하는 휘하 읽기와 장비·계략·서약은 다섯 값을 가정하지 않는다', () => {
    const state = commandWorld();
    for (const general of Object.values(state.generals)) {
      delete general.politics;
      delete general.charm;
    }
    expect(() => readCampaignState(state.campaign, state)).not.toThrow();
    expect(campaignPeople(state, state.campaign!).every((person) => !('charm' in person.stats))).toBe(true);
    const general = state.generals[1]!;
    const stats = generalStats(general);
    expect(withEquipmentBonus(state, 1, stats)).not.toHaveProperty('politics');
    expect(pledgeChance(general)).toBe(25 + Math.floor(general.leadership / 2));
    expect(Number.isFinite(stratagemAttackScore(general, 'incite', state))).toBe(true);
  });
  it('세 능력 지휘관의 실제 부곡 교전에서 NaN이나 ZodError를 만들지 않는다', () => {
    const state = commandWorld();
    for (const general of Object.values(state.generals)) {
      delete general.politics;
      delete general.charm;
      general.crew = 0;
    }
    const generals = Object.values(state.generals);
    const first = generals[0]!,
      second = generals.find((general) => general.nationId !== first.nationId)!;
    state.campaign!.units = [
      { id: 1, ownerId: first.id, commanderId: first.id, troops: 100, crewType: 1100, train: 50, atmos: 50 },
      { id: 2, ownerId: second.id, commanderId: second.id, troops: 100, crewType: 1100, train: 50, atmos: 50 },
    ];
    state.campaign!.nextUnitId = 3;
    const result = fightCampaignUnits(state, 1, 2, testUnits, rngFor('legacy-battle'));
    expect(Number.isFinite(result.attacker.crew)).toBe(true);
    expect(Number.isFinite(result.defender.crew)).toBe(true);
  });
});
