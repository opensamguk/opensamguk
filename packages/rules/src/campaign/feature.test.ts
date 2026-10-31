import { describe, expect, it } from 'vitest';
import { operationalInput } from '../../test/operationalMapFixture';
import { commandInitial } from '../../test/commandFixture';
import { buildInitialWorld } from '../world/bootstrap';
import { buildCreatedGeneral } from '../general/create';
import { checkReplayOrigin, ruleRegistry, type RuleRegistry } from '../ruleRegistry';
import {
  applyRecordedInput,
  initialReplayState,
  initialReplayStateWithRegistry,
  runReplayAction,
  type RecordedInput,
} from '../replay';
import { applyCampaignUnitInput } from './unitInputs';
import { applyCampaignRelationship } from './relationships';
import { applyCampaignOrder } from './orders';
import { resolverForRuleFeatures } from '../ruleCommands';
import { runGeneralTurn } from '../commands/turn';
import { TICKS_PER_MONTH } from '../clock/constants';

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

describe('AC-INT-19B 휘하 지시 입력과 실제 순수 턴의 재생', () => {
  function ordersFixture() {
    const f = fixture(),
      replay = f.created;
    Object.assign(replay.state.generals[1]!, { nationId: 1, officerLevel: 1, cityKey: 1 });
    Object.assign(replay.state.generals[3]!, { nationId: 1, officerLevel: 1, cityKey: 1 });
    replay.state.campaign!.links = [{ masterId: 3, personId: 1, relation: 'LIEUTENANT' }];
    const payload = {
      type: 'issue',
      recipientId: 1,
      command: { commandKey: 'rest', args: {} },
      revision: replay.state.campaign!.revision,
    };
    const outcome = applyCampaignOrder(replay.state, payload, 3, {
      tick: 1,
      userId: 'owner',
      userActive: true,
      turns: replay.turns,
      revisions: replay.revisions,
      resolver: resolverForRuleFeatures(replay.state)!,
      unitSet: f.initial.unitSet,
    });
    if (!outcome.ok) throw new Error(outcome.message);
    const record: RecordedInput = {
      sequence: 2,
      tick: 1,
      generalId: 3,
      kind: 'campaign.order',
      status: 'APPLIED',
      payload,
      result: { ...outcome.result, tick: 1 },
    };
    return { ...f, replay, outcome, record };
  }
  it('접수 재생은30칸·revision을 변경하지 않고 실제차례는 같은 명령·한shift·한revision을 재현한다', () => {
    const f = ordersFixture(),
      next = applyRecordedInput(f.replay, f.record);
    expect(next.state.campaign).toEqual(f.outcome.state.campaign);
    expect(next.turns).toEqual(f.replay.turns);
    expect(next.revisions).toEqual(f.replay.revisions);
    for (const general of Object.values(next.state.generals)) general.nextTurnTick = 10001;
    next.state.generals[1]!.nextTurnTick = 1;
    const direct = runGeneralTurn(
      next.state,
      { generalId: 1, tick: 1, unitSet: f.initial.unitSet },
      next.turns[1]![0]!,
      f.initial.seed,
      { policy: next.policy!.policies[1]!, turnRevision: next.revisions[1]! },
      resolverForRuleFeatures(next.state),
      { offices: next.offices! },
    );
    const replayed = runReplayAction(next, f.initial.seed, f.initial.unitSet);
    expect(direct.commandKey).toBe('rest');
    expect(replayed.state.campaign).toEqual(direct.state.campaign);
    expect(replayed.state.campaign!.orders!.items[0]!.status).toBe('EXECUTED');
    expect(replayed.state.generals[1]!.nextTurnTick).toBe(1 + TICKS_PER_MONTH);
    expect(replayed.revisions[1]).toBe(next.revisions[1]! + 1);
    expect(replayed.turns[1]).toHaveLength(30);
    expect(replayed.turns[3]).toEqual(next.turns[3]);
    expect(runReplayAction(next, f.initial.seed, f.initial.unitSet)).toEqual(replayed);
  });
  it('지시 재생은 호출한 등록표의 명령 해석기를 전달하고 직접 무문맥 적용은 거부한다', () => {
    const f = ordersFixture(),
      kind = registry.inputKinds.find((item) => item.kind === 'campaign.order')!,
      probe = { ...resolverForRuleFeatures(f.replay.state)!.get('rest')!, key: 'order_probe' };
    const custom: RuleRegistry = {
      ...registry,
      features: registry.features.map((feature) =>
        feature.key === 'five-stats'
          ? { ...feature, commandBindings: [...(feature.commandBindings ?? []), { definition: probe, sliceKeys: [] }] }
          : feature,
      ),
      inputKinds: registry.inputKinds.map((item) =>
        item !== kind
          ? item
          : {
              ...item,
              apply(replay, input, context) {
                expect(context?.resolver?.get('order_probe')).toMatchObject({ key: 'order_probe', name: probe.name });
                return kind.apply(replay, input, context);
              },
            },
      ),
    };
    expect(() => kind.apply(f.replay, f.record)).toThrow('명령 해석기');
    expect(applyRecordedInput(f.replay, f.record, custom).state.campaign).toEqual(f.outcome.state.campaign);
    expect(resolverForRuleFeatures(f.replay.state)!.get('order_probe')).toBeUndefined();
  });
  it.each(['result', 'tick', 'actor', 'args', 'issuer'])('기록의 %s 위조를 엄격하게 거부한다', (kind) => {
    const f = ordersFixture(),
      forged = structuredClone(f.record);
    if (kind === 'result') (forged.result as { orderId: number }).orderId++;
    if (kind === 'tick') forged.tick = 2;
    if (kind === 'actor') forged.generalId = 1;
    if (kind === 'args') (forged.payload as { command: { args: unknown } }).command.args = { forbidden: 1 };
    if (kind === 'issuer') (forged.payload as Record<string, unknown>).issuerId = 1;
    expect(() => applyRecordedInput(f.replay, forged)).toThrow();
  });
});
