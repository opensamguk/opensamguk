import { describe, expect, it } from 'vitest';
import { commandInitial, testUnits } from '../test/commandFixture';
import { buildCreatedGeneral } from './general/create';
import { applyRecordedInput, emptyTurns, initialReplayState } from './replay';
import { checkReplayOrigin, ruleRegistry, settleMonthlyFeatures, type RuleRegistry } from './ruleRegistry';

const initial = (features: string[]) => ({ ...commandInitial(), ruleFeatures: features });
const origin = (features: string[], featureData?: Record<string, import('./model/world').JsonValue>) => ({
  version: 3,
  initial: initial(features),
  initialStateHash: 'adapter-checks-hash',
  resourceHash: 'adapter-checks-hash',
  ...(featureData ? { featureData } : {}),
});

describe('형식 3의 정책·인사·조약 결합', () => {
  it('기능을 고르지 않으면 비공개 replay 키를 만들지 않는다', () => {
    const replay = initialReplayState(commandInitial());
    for (const key of ['policy', 'offices', 'residenceAnchors']) expect(Object.hasOwn(replay, key)).toBe(false);
    expect(Object.hasOwn(replay.state, 'ruleFeatures')).toBe(false);
  });

  it('정책의 턴 간격은 생성 자료에서 읽고 30칸은 빈칸으로 시작한다', () => {
    const data = { policy: { version: 1, turnTermMinutes: 60 } };
    expect(() => checkReplayOrigin(origin(['policy'], data))).not.toThrow();
    const replay = initialReplayState(initial(['policy']), data);
    expect(replay.policy).toMatchObject({ turnTermMinutes: 60, lastActiveTicks: {} });
    expect(replay.turns[1]).toHaveLength(30);
    expect(replay.turns[1]!.every((turn) => turn.explicit === false && turn.commandKey === 'rest')).toBe(true);
  });

  it.each([undefined, { version: 1, turnTermMinutes: 0 }, { version: 1, turnTermMinutes: 60, extra: true }])(
    '빠지거나 잘못된 정책 생성 자료를 거부한다 (%j)',
    (data) => {
      expect(() => checkReplayOrigin(origin(['policy'], data === undefined ? undefined : { policy: data }))).toThrow();
    },
  );

  it('인사는 빈 비공개 map으로 시작하고 WorldState에 앵커를 넣지 않는다', () => {
    const replay = initialReplayState(initial(['personnel']));
    expect(replay.offices).toEqual({});
    expect(replay.residenceAnchors).toEqual({});
    expect(Object.hasOwn(replay.state, 'residenceAnchors')).toBe(false);
    expect(Object.values(replay.state.generals).some((general) => Object.hasOwn(general, 'residenceTick'))).toBe(false);
  });

  it('사람이 든 인사 생성 기록은 앵커를 추정하지 않고 거부한다', () => {
    const value = origin(['personnel']);
    value.initial.generals[0]!.userId = 'handmade';
    expect(() => checkReplayOrigin(value)).toThrow('기존 사람 장수');
  });

  it('생성105 뒤 개인 칸 저장과 직책 칸 편집100은 앵커105를 보존한다', () => {
    const source = initial(['personnel']);
    source.generals[3]!.nationId = 1;
    source.generals[3]!.officerLevel = 5;
    const before = initialReplayState(source);
    const general = buildCreatedGeneral({
      payload: { name: '새장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
      seed: source.seed,
      userId: 'created',
      id: 5,
      startYear: source.startYear,
      monthlyTick: 0,
      tick: 105,
      cityKeys: source.cities.map((city) => city.cityKey),
      unitSet: testUnits,
    });
    const created = applyRecordedInput(before, {
      sequence: 1,
      tick: 105,
      kind: 'general.create',
      generalId: 5,
      status: 'APPLIED',
      payload: {},
      result: { general },
    });
    const edited = applyRecordedInput(created, {
      sequence: 2,
      tick: null,
      kind: 'turns.set',
      generalId: 5,
      status: 'APPLIED',
      payload: { turns: emptyTurns(), revision: 0 },
      result: { revision: 1 },
    });
    expect(edited.residenceAnchors).toEqual({ 5: 105 });
    const national = applyRecordedInput(edited, {
      sequence: 3,
      tick: 100,
      kind: 'nationTurns.set',
      generalId: 4,
      status: 'APPLIED',
      payload: {
        office: { nationId: 1, officerLevel: 5, tenure: 0 },
        revision: 0,
        turns: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
      },
      result: { revision: 1 },
    });
    expect(national.residenceAnchors).toEqual({ 5: 105 });
    expect(before.residenceAnchors).toEqual({});
  });

  it('직책 칸은 directTick을 요구하고 개인 칸은 기존 direct 규칙이다', () => {
    expect(ruleRegistry.inputKinds.find((kind) => kind.kind === 'nationTurns.set')).toMatchObject({
      route: 'direct',
      directTick: true,
    });
    expect(ruleRegistry.inputKinds.find((kind) => kind.kind === 'turns.set')!.directTick).toBeUndefined();
  });

  it('꺼진 기능의 APPLIED와 다른 이유의 REJECTED를 거부한다', () => {
    const replay = initialReplayState(commandInitial());
    const record = { sequence: 1, tick: 100, kind: 'general.active', generalId: 3, payload: {} };
    expect(() => applyRecordedInput(replay, { ...record, status: 'APPLIED', result: { activeTick: 100 } })).toThrow();
    expect(() =>
      applyRecordedInput(replay, { ...record, status: 'REJECTED', result: { code: 'BAD_POLICY', message: '오류' } }),
    ).toThrow();
    expect(
      applyRecordedInput(replay, {
        ...record,
        status: 'REJECTED',
        result: { code: 'FEATURE_DISABLED', message: '꺼진 기능' },
      }),
    ).toBe(replay);
  });

  it('월간 기능은 알파벳 대신 조약 다음 인사 순서로 실행한다', () => {
    const before = initialReplayState(initial(['personnel', 'treaty']));
    const calls: string[] = [];
    const registry: RuleRegistry = {
      inputKinds: [],
      monthlyOrder: ['treaty', 'personnel'],
      features: ['personnel', 'treaty'].map((key) => ({
        key,
        requires: [],
        conflicts: [],
        settleMonthly({ settled }) {
          calls.push(key);
          return { replay: settled, effects: key };
        },
      })),
    };
    expect(settleMonthlyFeatures(before, before, 10_000, registry).effects).toEqual({
      treaty: 'treaty',
      personnel: 'personnel',
    });
    expect(calls).toEqual(['treaty', 'personnel']);
    expect(() => settleMonthlyFeatures(before, before, 10_000, { ...registry, monthlyOrder: ['personnel'] })).toThrow();
  });

  it('조약 파기는 조약 기능을 함께 선택하고 빈 신의 상태에서 시작한다', () => {
    expect(() => checkReplayOrigin(origin(['treaty-break']))).toThrow('의존');
    expect(() => checkReplayOrigin(origin(['treaty', 'treaty-break']))).not.toThrow();
    const replay = initialReplayState(initial(['treaty', 'treaty-break']));
    expect(Object.hasOwn(replay.state, 'nationTrust')).toBe(false);
    expect(ruleRegistry.inputKinds.find((kind) => kind.kind === 'treaty.break')).toMatchObject({
      feature: 'treaty-break',
      route: 'queued',
    });
  });

  it('실제 등록표로 조약 제안과 파기를 재현하고 신의는 한 번만 바꾼다', () => {
    const before = initialReplayState(initial(['treaty', 'treaty-break']));
    const accepted = applyRecordedInput(before, {
      sequence: 10,
      tick: 100,
      kind: 'treaty.propose',
      generalId: 1,
      status: 'APPLIED',
      payload: { toNationId: 2, clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 3 }] },
      result: { outcome: 'ACCEPTED', by: 'NPC', tick: 100, treatyId: '10', cost: { from: 50, to: 25 }, endTick: 30100 },
    });
    const broken = applyRecordedInput(accepted, {
      sequence: 20,
      tick: 200,
      kind: 'treaty.break',
      generalId: 1,
      status: 'APPLIED',
      payload: { treatyId: '10' },
      result: { outcome: 'BROKEN', tick: 200, treatyId: '10', brokenByNationId: 1 },
    });
    expect(broken.state.nationTrust).toEqual([{ nationId: 1, brokenTreaties: 1, lastBrokenTick: 200 }]);
    expect(broken.state.treaties).toBeUndefined();
    expect(accepted.state.treaties).toHaveLength(1);
    expect(accepted.state.nationTrust).toBeUndefined();
    expect(before.state.treaties).toBeUndefined();
  });
});
