import { describe, expect, it } from 'vitest';
import { commandWorld, commandInitial } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { respondAssignment } from '../personnel/assignments';
import { emptyTurns, type ReplayState } from '../replay';
import { checkRuleFeatures, settleMonthlyFeatures } from '../ruleRegistry';
import { emptyCampaignState } from './state';
import { campaignFeature } from './feature';
import { campaignAssignmentFeature } from './assignment';

function fixture(corrected = true): ReplayState {
  const state = commandWorld();
  for (const general of Object.values(state.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1, nationId: 1, officerLevel: 1 });
  Object.assign(state.generals[1]!, { userId: 'owner' });
  Object.assign(state.generals[3]!, { userId: 'other' });
  state.generals[4]!.officerLevel = 12;
  state.cities[2]!.nationId = 1;
  state.nations[1]!.isNpc = false;
  state.ruleFeatures = [
    ...(corrected ? ['campaign-assignment-v2'] : []),
    'campaign-v1',
    'five-stats',
    'operational-map',
    'personnel',
    'policy',
  ];
  state.campaign = emptyCampaignState(state, 'assignment-seed', 'sourced-test');
  state.campaign.links = [
    { masterId: 1, personId: 2, relation: 'LIEUTENANT' },
    { masterId: 1, personId: 3, relation: 'STAFF' },
  ];
  state.campaign.units = [{ id: 1, ownerId: 1, commanderId: 2, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
  state.campaign.nextUnitId = 2;
  state.assignmentOffers = {
    1: { id: '10000-4-1', nationId: 1, issuerGeneralId: 4, cityKey: 2, createdTick: 10000, expiresTick: 30000 },
  };
  return {
    state,
    turns: Object.fromEntries(Object.values(state.generals).map(({ id }) => [id, emptyTurns()])),
    revisions: { 1: 0, 2: 0, 3: 0, 4: 0 },
    monthlyTick: 20000,
    offices: {},
    residenceAnchors: { 1: 0, 3: 0 },
  };
}

function expire(before: ReplayState) {
  return settleMonthlyFeatures(
    deepFreeze(before),
    deepFreeze({ ...structuredClone(before), monthlyTick: 30000 }),
    30000,
  ).replay;
}

describe('AC-INT-09 발령 기한 수락과 부곡 동행의 원생성별 규칙 판', () => {
  it('기존 campaign-v1의 월간 결과는 바꾸지 않는다', () => {
    const before = fixture(false),
      after = expire(before);
    expect(after.state.generals[1]!.cityKey).toBe(2);
    expect(after.state.generals[2]!.cityKey).toBe(1);
    expect(after.state.assignmentOffers).toBeUndefined();
    expect(after.state.ruleFeatures).toEqual(before.state.ruleFeatures);
  });

  it('보완판의 명시 수락과 기한 수락은 집결한 NPC 부장만 같은 목적지로 보낸다', () => {
    const before = fixture(),
      after = expire(before);
    const accepted = respondAssignment(before.state, 1, '10000-4-1', true, 30000);
    if (!accepted.ok) throw new Error(accepted.code);
    const explicit = campaignFeature.afterAppliedInput!(
      before,
      { ...before, state: accepted.state },
      {
        sequence: 1,
        tick: 30000,
        generalId: 1,
        kind: 'offer.respond',
        status: 'APPLIED',
        payload: {},
        result: {},
      },
    );
    expect([1, 2, 3].map((id) => after.state.generals[id]!.cityKey)).toEqual([2, 2, 1]);
    expect([1, 2, 3].map((id) => explicit.state.generals[id]!.cityKey)).toEqual([2, 2, 1]);
    expect(after.state.campaign).toEqual(before.state.campaign);
    expect(after.turns).toEqual(before.turns);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.residenceAnchors).toEqual({ 1: 30000, 3: 0 });
    for (const general of Object.values(after.state.generals))
      expect(general.rice).toBe(before.state.generals[general.id]!.rice);
    expect(expire(before)).toEqual(after);
    expect(before.state.generals[1]!.cityKey).toBe(1);
    expect(before.state.generals[2]!.cityKey).toBe(1);
    expect(before.state.assignmentOffers?.[1]?.id).toBe('10000-4-1');
  });

  it.each(['away', 'empty', 'already-moved'] as const)('%s 부장은 월간 처리 뒤에도 순간 이동시키지 않는다', (kind) => {
    const before = fixture();
    if (kind === 'away') before.state.generals[2]!.cityKey = 3;
    if (kind === 'empty') before.state.campaign!.units[0]!.troops = 0;
    const settled = structuredClone(before);
    settled.monthlyTick = 30000;
    if (kind === 'already-moved') settled.state.generals[2]!.cityKey = 4;
    const after = settleMonthlyFeatures(deepFreeze(before), deepFreeze(settled), 30000).replay;
    expect(after.state.generals[1]!.cityKey).toBe(2);
    expect(after.state.generals[2]!.cityKey).toBe(settled.state.generals[2]!.cityKey);
    expect(after.state.campaign).toEqual(before.state.campaign);
  });

  it('새 판은 campaign-v1 의존성과 원생성의 명시 선택을 검사한다', () => {
    const before = fixture();
    expect(checkRuleFeatures(before.state.ruleFeatures)).toEqual(before.state.ruleFeatures);
    expect(() => checkRuleFeatures(['campaign-assignment-v2'])).toThrow('의존');
    expect(() => campaignAssignmentFeature.checkOrigin!({ initial: commandInitial(), data: {} })).toThrow('초기 자료');
  });
});
