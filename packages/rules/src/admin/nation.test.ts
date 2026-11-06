import { expect, it } from 'vitest';
import { commandInitial, testUnits } from '../../test/commandFixture';
import { applyRecordedInput, initialReplayState, type RecordedInput } from '../replay';
import { ruleRegistry } from '../ruleRegistry';
import { adminGamePayloadSchema, type AdminGameAction } from './game';
import { decideAdminGameAction } from './apply';

const context = { userActive: true, admin: true, sanctioned: false, replayFormat: 3, worldStatus: 'PAUSED', tick: 0 };
const rulerAction = { kind: 'admin.nation.setRuler', nationId: 2, generalId: 3, expectedRulerId: 2 } as const;
const disbandAction = { kind: 'admin.nation.disband', nationId: 2 } as const;
const payload = (action: unknown) => ({ version: 1, reason: '국가 운영 조치', action });
function fixture(features = ['personnel', 'policy']) {
  const initial = commandInitial();
  initial.ruleFeatures = features;
  for (const general of initial.generals) Object.assign(general, { politics: 60, charm: 55 });
  const replay = initialReplayState(initial, { policy: { version: 1, turnTermMinutes: 60 } });
  replay.state.generals[2]!.experience = 5;
  replay.state.generals[2]!.userId = 'old-ruler';
  replay.state.generals[3]!.userId = 'new-ruler';
  replay.state.generals[3]!.officerLevel = 11;
  replay.residenceAnchors = { 2: 0, 3: 0 };
  return replay;
}
function apply(action: AdminGameAction, replay = fixture()) {
  return decideAdminGameAction(replay, payload(action), context);
}

it('AC-INT-23 국가 조치는 위조 필드와 누락된 expected 군주를 받지 않는다', () => {
  expect(adminGamePayloadSchema.parse(payload(rulerAction)).action).toEqual(rulerAction);
  expect(adminGamePayloadSchema.parse(payload(disbandAction)).action).toEqual(disbandAction);
  for (const action of [
    { ...rulerAction, expectedRulerId: undefined },
    { ...rulerAction, expectedRulerId: 0 },
    { ...rulerAction, userId: 'forged' },
    { ...disbandAction, force: true },
  ])
    expect(adminGamePayloadSchema.safeParse(payload(action)).success).toBe(false);
});

it.each([null, 'new-ruler'])(
  'AC-INT-23 기능이 꺼진 첫 달에도 군주를 교체하고 개인 30칸·활동은 보존한다 (%s)',
  (userId) => {
    const replay = fixture();
    replay.state.generals[3]!.userId = userId;
    if (userId === null) delete replay.residenceAnchors![3];
    replay.turns[2]![0] = { commandKey: 'farm', args: {}, explicit: true };
    replay.policy!.lastActiveTicks[2] = 0;
    const original = structuredClone(replay);
    const outcome = apply(rulerAction, replay);
    expect(outcome.status).toBe('APPLIED');
    expect(outcome.result).toEqual({
      version: 1,
      before: { rulerId: 2, previousRulerExperience: 5, nationIsNpc: true },
      after: { rulerId: 3, previousRulerExperience: 4, nationIsNpc: userId === null },
    });
    const input: RecordedInput = {
      sequence: 1,
      tick: 0,
      generalId: null,
      kind: rulerAction.kind,
      status: outcome.status,
      payload: payload(rulerAction),
      result: outcome.result,
    };
    const next = applyRecordedInput(replay, input, ruleRegistry, { unitSet: testUnits });
    expect(next.state.generals[2]).toEqual({ ...replay.state.generals[2], officerLevel: 1, experience: 4 });
    expect(next.state.generals[3]).toEqual({ ...replay.state.generals[3], officerLevel: 12 });
    expect(next.turns).toEqual(original.turns);
    expect(next.revisions).toEqual(original.revisions);
    expect(next.policy).toEqual(original.policy);
    expect(next.offices![2]![11]!.revision).toBe(1);
    expect(next.offices![2]![12]!.revision).toBe(1);
    expect(replay).toEqual(original);
    expect(() =>
      applyRecordedInput(replay, { ...input, result: { ...outcome.result, after: {} } }, ruleRegistry),
    ).toThrow();
    expect(apply(rulerAction, next)).toMatchObject({ status: 'REJECTED', result: { code: 'TARGET_CHANGED' } });
  },
);

it('AC-INT-23 군주 교체는 참조·생존·등장과 접수 당시 군주를 다시 검사한다', () => {
  const replay = fixture();
  for (const [action, code] of [
    [{ ...rulerAction, nationId: 999 }, 'TARGET_MISSING'],
    [{ ...rulerAction, generalId: 999 }, 'TARGET_MISSING'],
    [{ ...rulerAction, expectedRulerId: 1 }, 'TARGET_CHANGED'],
    [{ ...rulerAction, generalId: 1 }, 'INVALID_VALUE'],
    [{ ...rulerAction, generalId: 2 }, 'INVALID_VALUE'],
  ] as const)
    expect(apply(action, replay)).toMatchObject({ status: 'REJECTED', result: { code }, replay });
  replay.state.generals[3]!.activeFromYear = 192;
  expect(apply(rulerAction, replay)).toMatchObject({ result: { code: 'INVALID_VALUE' } });
  replay.state.generals[3]!.removedAt = 0;
  expect(apply(rulerAction, replay)).toMatchObject({ result: { code: 'TARGET_MISSING' } });
  expect(() =>
    decideAdminGameAction(fixture(), payload(rulerAction), {
      userActive: true,
      admin: true,
      sanctioned: false,
      replayFormat: 3,
      worldStatus: 'PAUSED',
    }),
  ).toThrow('tick');
});

it.each([false, true])(
  'AC-INT-23 운영 해산은 도시 보유·전쟁·첫 달에도 같은 자원 상한을 적용한다 (방랑 기능 %s)',
  (enabled) => {
    const replay = fixture(['personnel', 'policy', ...(enabled ? ['nation-lifecycle-v1'] : [])]);
    replay.state.generals[3]!.rice = 7;
    const original = structuredClone(replay);
    const outcome = apply(disbandAction, replay);
    expect(outcome.status).toBe('APPLIED');
    const next = applyRecordedInput(
      replay,
      {
        sequence: 1,
        tick: 0,
        generalId: null,
        kind: disbandAction.kind,
        status: outcome.status,
        payload: payload(disbandAction),
        result: outcome.result,
      },
      ruleRegistry,
    );
    expect(outcome.result).toEqual({
      version: 1,
      before: { exists: true, members: 2, cities: 1 },
      after: { exists: false, members: 0, cities: 0 },
    });
    expect(next.state.nations[2]).toBeUndefined();
    expect(next.state.cities[2]).toMatchObject({ nationId: null, supplied: false });
    expect(next.state.generals[2]).toMatchObject({
      nationId: null,
      officerLevel: 0,
      gold: 1000,
      rice: 1000,
      crew: 0,
      train: 0,
      atmos: 0,
      userId: 'old-ruler',
    });
    expect(next.state.generals[3]).toMatchObject({
      nationId: null,
      officerLevel: 0,
      gold: 1000,
      rice: 7,
      crew: 0,
      train: 0,
      atmos: 0,
    });
    expect(next.state.generals[1]).toEqual(original.state.generals[1]);
    expect(next.state.diplomacies).toEqual([]);
    expect(next.offices![2]).toBeUndefined();
    expect(next.turns).toEqual(original.turns);
    expect(next.revisions).toEqual(original.revisions);
    expect(replay).toEqual(original);
    expect(apply(disbandAction, next)).toMatchObject({ result: { code: 'TARGET_MISSING' } });
  },
);

it('AC-INT-23 부곡·도시 수비병은 해산하고 변경 한도에서는 부분 적용하지 않는다', () => {
  const replay = fixture(['campaign-assignment-v2', 'campaign-v1', 'city-resources-v1', 'personnel', 'policy']);
  replay.state.campaign!.units = [
    { id: 1, ownerId: 2, commanderId: 2, troops: 100, crewType: 1100, train: 50, atmos: 50 },
    { id: 2, ownerId: 3, commanderId: 3, troops: 200, crewType: 1100, train: 50, atmos: 50 },
  ];
  replay.state.campaign!.nextUnitId = 3;
  replay.state.cityResources!.cities['2']!.garrison = [{ crewType: 1100, troops: 50, train: 30, atmos: 40 }];
  const original = structuredClone(replay);
  const outcome = apply(disbandAction, replay);
  expect(outcome.status).toBe('APPLIED');
  expect(outcome.replay.state.campaign!.units.filter((unit) => [2, 3].includes(unit.ownerId))).toSatisfy(
    (units: { troops: number; train: number; atmos: number }[]) =>
      units.length > 0 && units.every((unit) => unit.troops === 0 && unit.train === 0 && unit.atmos === 0),
  );
  expect(outcome.replay.state.campaign!.revision).toBe(replay.state.campaign!.revision + 1);
  expect(outcome.replay.state.cityResources!.cities['2']).toEqual({
    ...replay.state.cityResources!.cities['2'],
    garrison: [],
  });
  expect(outcome.replay.state.cities[2]!.population).toBe(original.state.cities[2]!.population + 50);
  expect(replay).toEqual(original);
  replay.state.campaign!.revision = 2_147_483_647;
  expect(apply(disbandAction, replay)).toMatchObject({ status: 'REJECTED', result: { code: 'INVALID_VALUE' }, replay });
  for (const unit of replay.state.campaign!.units)
    if ([2, 3].includes(unit.ownerId)) unit.troops = unit.train = unit.atmos = 0;
  expect(apply(disbandAction, replay).status).toBe('APPLIED');
});
