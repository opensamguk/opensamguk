import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import type { RecordedInput } from '../replay';
import { deepFreeze } from '../personnel/testFixture';
import { applyCampaignRelationship } from './relationships';
import { replayCampaignRelationship } from './record';
import { emptyCampaignState } from './state';
import { cloneWorld } from '../model/clone';

function fixture() {
  const world = commandWorld();
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1 });
  Object.assign(world.generals[1]!, { userId: 'owner', gold: 1000 });
  Object.assign(world.generals[2]!, { nationId: 1, officerLevel: 1 });
  const campaign = emptyCampaignState(world, 'ledger-test-seed', 'source-scenario');
  const payload = { type: 'offer', targetId: 2, relation: 'LIEUTENANT', revision: 0 };
  const result = applyCampaignRelationship(world, payload, 1, campaign, {
    tick: 10000,
    userId: 'owner',
    userActive: true,
  });
  if (!result.ok) throw new Error(result.code);
  const record: RecordedInput = {
    sequence: 1,
    tick: 10000,
    generalId: 1,
    kind: 'campaign.relationship',
    status: 'APPLIED',
    payload,
    result: { ...result.result, tick: 10000 },
  };
  return { world, campaign, result, record };
}

describe('AC-INT-06 휘하 관계 원장 재계산', () => {
  it('재시작 때 저장한 JSON에서 비용·NPC 결과·전체 상태를 같은 시드로 재현한다', () => {
    const f = fixture();
    const replay = replayCampaignRelationship(
      deepFreeze(f.world),
      JSON.parse(JSON.stringify(f.campaign)),
      JSON.parse(JSON.stringify(f.record)),
    );
    expect(replay).toEqual({ state: f.result.state, campaign: f.result.campaign });
    expect(JSON.stringify(replay)).toBe(JSON.stringify({ state: f.result.state, campaign: f.result.campaign }));
    expect(f.world.generals[1]!.gold).toBe(1000);
  });
  it('cloneWorld의 부곡을 바꿔도 원본 병력·출처·관계가 바뀌지 않는다', () => {
    const f = fixture();
    f.world.campaign = f.campaign;
    f.world.campaign.units.push({
      id: 1,
      ownerId: 1,
      commanderId: 1,
      troops: 500,
      crewType: 1100,
      train: 50,
      atmos: 50,
    });
    f.world.campaign.nextUnitId = 2;
    const next = cloneWorld(deepFreeze(f.world));
    next.campaign!.units[0]!.troops = 0;
    next.campaign!.sources['1'] = 'changed';
    expect(f.world.campaign.units[0]!.troops).toBe(500);
    expect(f.world.campaign.sources['1']).toBe('scenario:source-scenario#general:1');
  });
  it('typed WorldState의 관계 전이와 재생은 같은 최신 campaign을 반환한다', () => {
    const f = fixture();
    f.world.campaign = f.campaign;
    const replayed = replayCampaignRelationship(deepFreeze(f.world), f.campaign, f.record);
    expect(replayed.state.campaign).toEqual(replayed.campaign);
    expect(replayed.state.campaign!.revision).toBe(1);
    expect(f.world.campaign.revision).toBe(0);
    expect(() =>
      applyCampaignRelationship(
        f.world,
        f.record.payload,
        1,
        { ...f.campaign, revision: 1 },
        {
          tick: 10000,
          userId: 'owner',
          userActive: true,
        },
      ),
    ).toThrow('월드와 휘하 입력');
  });
  it.each(['accepted', 'cost', 'chance', 'roll', 'revision', 'tick'])(
    '기록의 %s를 바꿔 성공·무료·월별 재시도를 위조할 수 없다',
    (key) => {
      const f = fixture();
      const result = { ...(f.record.result as Record<string, unknown>) };
      result[key] = key === 'accepted' ? !result[key] : Number(result[key]) + 1;
      expect(() => replayCampaignRelationship(f.world, f.campaign, { ...f.record, result })).toThrow();
    },
  );
  it('적용 결과의 임의 필드·입력 권한 위조·이미 적용한 revision을 거부한다', () => {
    const f = fixture();
    expect(() =>
      replayCampaignRelationship(f.world, f.campaign, {
        ...f.record,
        result: { ...(f.record.result as object), goldRefund: 500 },
      }),
    ).toThrow();
    expect(() => replayCampaignRelationship(f.world, f.campaign, { ...f.record, generalId: 2 })).toThrow();
    expect(() => replayCampaignRelationship(f.result.state, f.result.campaign, f.record)).toThrow();
  });
  it('거절은 상태·비용을 바꾸지 않고 거절 결과의 추가 필드를 허용하지 않는다', () => {
    const f = fixture();
    const rejected: RecordedInput = {
      ...f.record,
      status: 'REJECTED',
      result: { code: 'ACTOR_INACTIVE', message: '활성 계정이 아닙니다.' },
    };
    expect(replayCampaignRelationship(deepFreeze(f.world), deepFreeze(f.campaign), rejected)).toEqual({
      state: f.world,
      campaign: f.campaign,
    });
    expect(() =>
      replayCampaignRelationship(f.world, f.campaign, { ...rejected, result: { code: 'BAD_INPUT' } }),
    ).toThrow();
  });
});
