import { describe, expect, it } from 'vitest';
import { operationalInput } from '../../test/operationalMapFixture';
import { commandInitial } from '../../test/commandFixture';
import { buildInitialWorld } from '../world/bootstrap';
import { buildCreatedGeneral } from '../general/create';
import { checkReplayOrigin, ruleRegistry } from '../ruleRegistry';
import { applyRecordedInput, initialReplayState, initialReplayStateWithRegistry, type RecordedInput } from '../replay';
import { applyCampaignUnitInput } from './unitInputs';
import { applyCampaignRelationship } from './relationships';

const registry = ruleRegistry;
const data = { policy: { version: 1, turnTermMinutes: 60 } };
function fixture() {
  const initial = buildInitialWorld(operationalInput());
  initial.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  Object.assign(initial.generals[0]!, { nationId: null, officerLevel: 0 });
  const replay = initialReplayStateWithRegistry(initial, registry, data);
  const payload = {
    name: '사람장수',
    portraitId: null,
    leadership: 55,
    strength: 55,
    intel: 55,
    politics: 55,
    charm: 55,
  };
  const general = buildCreatedGeneral({
    payload,
    seed: initial.seed,
    userId: 'owner',
    id: 3,
    startYear: 191,
    monthlyTick: 0,
    tick: 0,
    cityKeys: [1],
    unitSet: initial.unitSet,
  });
  const creation: RecordedInput = {
    sequence: 1,
    tick: 0,
    generalId: 3,
    kind: 'general.create',
    status: 'APPLIED',
    payload,
    result: { general, activeTick: 0 },
  };
  const created = applyRecordedInput(replay, creation, registry);
  return { initial, replay, created, creation };
}
describe('AC-INT-06 휘하 프로필 생성·입력 재생 계약', () => {
  it('원생성의 출처·시드·병종 목록과 새 사람 생성 입력의 출처를 해시에 담는 상태에 보존한다', () => {
    const f = fixture();
    expect(f.replay.campaignArmyTypes).toEqual([1100, 1200, 1300]);
    expect(f.replay.state.campaign!.sources['1']).toBe(`scenario:${f.initial.scenarioKey}#general:1`);
    expect(f.created.state.campaign!.sources['3']).toBe('input:1#general:3');
    expect(f.created.state.campaign!.revision).toBe(1);
    expect(f.replay.state.campaign!.sources['3']).toBeUndefined();
    expect(f.created.residenceAnchors![3]).toBe(0);
  });
  it('실제 편성 입력 결과를 재계산하고 결과·tick·미등록 병종 위조를 거부한다', () => {
    const f = fixture(),
      payload = { type: 'form', commanderId: 3, crewType: 1100, revision: 1 };
    const applied = applyCampaignUnitInput(f.created.state, payload, 3, f.created.state.campaign, {
      tick: 1,
      userId: 'owner',
      userActive: true,
      armyTypes: f.created.campaignArmyTypes!,
    });
    if (!applied.ok) throw new Error(applied.message);
    const record: RecordedInput = {
      sequence: 2,
      tick: 1,
      generalId: 3,
      kind: 'campaign.unit',
      status: 'APPLIED',
      payload,
      result: { ...applied.result, tick: 1 },
    };
    const next = applyRecordedInput(f.created, record, registry);
    expect(next.state.campaign).toEqual(applied.campaign);
    expect(() =>
      applyRecordedInput(f.created, { ...record, result: { ...applied.result, tick: 2 } }, registry),
    ).toThrow();
    expect(() =>
      applyRecordedInput(f.created, { ...record, result: { ...applied.result, unitId: 999, tick: 1 } }, registry),
    ).toThrow();
    expect(() =>
      applyRecordedInput(f.created, { ...record, payload: { ...payload, crewType: 1000 } }, registry),
    ).toThrow();
  });
  it('NPC 서약의 실제 비용·확률·월별 원장을 기존 인사 후처리와 함께 재현한다', () => {
    const f = fixture(),
      payload = { type: 'offer', targetId: 1, relation: 'LIEUTENANT', revision: 1 };
    f.created.state.generals[3]!.gold = 1000;
    Object.assign(f.created.state.generals[3]!, { nationId: 1, officerLevel: 1 });
    const applied = applyCampaignRelationship(f.created.state, payload, 3, f.created.state.campaign, {
      tick: 1,
      userId: 'owner',
      userActive: true,
    });
    if (!applied.ok) throw new Error(applied.message);
    const record: RecordedInput = {
      sequence: 2,
      tick: 1,
      generalId: 3,
      kind: 'campaign.relationship',
      status: 'APPLIED',
      payload,
      result: { ...applied.result, tick: 1 },
    };
    const next = applyRecordedInput(f.created, record, registry);
    expect(next.state.campaign).toEqual(applied.campaign);
    expect(next.state.generals[3]!.gold).toBe(500);
    expect(() =>
      applyRecordedInput(f.created, { ...record, result: { ...applied.result, cost: 0, tick: 1 } }, registry),
    ).toThrow();
  });
  it('의존 기능·General 병력 중복·별도 가짜 초기 상태를 거부하며 구형 상태에는 키를 더하지 않는다', () => {
    const f = fixture();
    const origin = {
      version: 3,
      initial: f.initial,
      initialStateHash: 'hash',
      resourceHash: 'hash',
      featureData: data,
    };
    expect(() => checkReplayOrigin(origin, registry)).not.toThrow();
    const bad = structuredClone(origin);
    bad.initial.ruleFeatures = bad.initial.ruleFeatures!.filter((key) => key !== 'personnel');
    expect(() => checkReplayOrigin(bad, registry)).toThrow();
    const duplicate = structuredClone(origin);
    duplicate.initial.generals[0]!.crew = 100;
    expect(() => checkReplayOrigin(duplicate, registry)).toThrow();
    expect(Object.hasOwn(initialReplayState(commandInitial()), 'campaignArmyTypes')).toBe(false);
    expect(Object.hasOwn(initialReplayState(commandInitial()).state, 'campaign')).toBe(false);
  });
});
