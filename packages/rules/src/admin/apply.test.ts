import { expect, it } from 'vitest';
import { commandInitial, testUnits } from '../../test/commandFixture';
import { initialReplayState, applyRecordedInput, type RecordedInput } from '../replay';
import { ruleRegistry } from '../ruleRegistry';
import { emptyQueue } from '../policy';
import { decideAdminGameAction, validateAdminGameRecord, type AdminGameContext } from './apply';
import type { AdminGameAction } from './game';

const context: AdminGameContext = {
  userActive: true,
  admin: true,
  sanctioned: false,
  replayFormat: 3,
  worldStatus: 'PAUSED',
  unitSet: testUnits,
};
const payload = (action: AdminGameAction) => ({ version: 1, reason: '운영 검증', action });
function fixture(features: string[] = []) {
  const initial = commandInitial();
  initial.ruleFeatures = features;
  return initialReplayState(
    initial,
    features.includes('policy') ? { policy: { version: 1, turnTermMinutes: 10 } } : undefined,
  );
}
function apply(action: AdminGameAction, replay = fixture(), overrides: Partial<AdminGameContext> = {}) {
  return decideAdminGameAction(replay, payload(action), { ...context, ...overrides });
}

it('AC-INT-23 8종 조치를 기록으로 재생하고 원본·활동·기존 병력은 보존한다', () => {
  const replay = fixture(['personnel', 'policy']);
  replay.state.generals[1]!.userId = 'human';
  replay.state.nations[1]!.isNpc = false;
  replay.policy!.lastActiveTicks[1] = 5;
  replay.residenceAnchors![1] = 0;
  replay.state.generals[3]!.officerLevel = 11;
  replay.turns[1]![0] = { commandKey: 'farm', args: { nested: { z: 2, a: 1 } }, explicit: true };
  const original = structuredClone(replay);
  const actions: AdminGameAction[] = [
    { kind: 'admin.general.rename', generalId: 1, name: '새장수' },
    { kind: 'admin.general.release', generalId: 1 },
    { kind: 'admin.general.clearTurns', generalId: 1 },
    {
      kind: 'admin.general.adjust',
      generalId: 1,
      changes: {
        gold: { expected: 100000, value: 123 },
        cityKey: { expected: 1, value: 3 },
        crewType: { expected: 1100, value: 1200 },
      },
    },
    {
      kind: 'admin.city.adjust',
      cityKey: 1,
      changes: { population: { expected: 20000, value: 30000 }, trust: { expected: 80, value: 80.5 } },
    },
    { kind: 'admin.nation.adjust', nationId: 1, changes: { tech: { expected: 0, value: 12000 } } },
    { kind: 'admin.nation.rename', nationId: 1, name: '새국가' },
    { kind: 'admin.nation.dismissOffice', nationId: 2, generalId: 3 },
  ];
  for (const action of actions) {
    const outcome = apply(action, replay);
    expect(outcome.status).toBe('APPLIED');
    const input: RecordedInput = {
      sequence: 1,
      tick: 10,
      generalId: null,
      kind: action.kind,
      payload: payload(action),
      status: outcome.status,
      result: outcome.result,
    };
    validateAdminGameRecord(input);
    const next = applyRecordedInput(replay, input, ruleRegistry, { unitSet: testUnits });
    if (action.kind === 'admin.general.release') {
      expect(next.state.generals[1]!.userId).toBeNull();
      expect(next.state.nations[1]!.isNpc).toBe(true);
      expect(next.policy!.lastActiveTicks).toEqual({});
      expect(next.state.generals[1]!.crew).toBe(10000);
      expect(next.state.generals[1]!.officerLevel).toBe(12);
    } else if (action.kind === 'admin.general.clearTurns') {
      expect(next.turns[1]).toEqual(emptyQueue());
      expect(next.revisions[1]).toBe(1);
      expect(next.policy!.lastActiveTicks[1]).toBe(5);
    } else if (action.kind === 'admin.nation.dismissOffice') {
      expect(next.state.generals[3]!.officerLevel).toBe(1);
      expect(next.offices?.[2]?.[11]?.revision).toBe(1);
    }
    expect(replay).toEqual(original);
  }
});

it('AC-INT-23 인증·월드·대상·expected·부곡·범위의 거절 순서를 유지한다', () => {
  const replay = fixture();
  const action: AdminGameAction = {
    kind: 'admin.general.adjust',
    generalId: 1,
    changes: { gold: { expected: 100000, value: 20 }, rice: { expected: 99, value: 30 } },
  };
  for (const [overrides, code] of [
    [{ userActive: false, admin: false, sanctioned: true }, 'ACTOR_INACTIVE'],
    [{ admin: false, sanctioned: true }, 'ADMIN_REQUIRED'],
    [{ sanctioned: true, replayFormat: 1 }, 'ACTOR_SANCTIONED'],
    [{ replayFormat: 1, worldStatus: 'ENDED' }, 'UNSUPPORTED_FORMAT'],
    [{ worldStatus: 'ENDED' }, 'WORLD_STATE_CHANGED'],
    [{}, 'TARGET_CHANGED'],
  ] as const)
    expect(apply(action, replay, overrides)).toMatchObject({ status: 'REJECTED', result: { code }, replay });
  expect(replay.state.generals[1]!.gold).toBe(100000);
  expect(apply({ kind: 'admin.general.rename', generalId: 99, name: '새이름' })).toMatchObject({
    result: { code: 'TARGET_MISSING' },
  });
  replay.state.ruleFeatures!.push('campaign-v1');
  const campaign: AdminGameAction = {
    kind: 'admin.general.adjust',
    generalId: 1,
    changes: { train: { expected: 99, value: 50 } },
  };
  expect(apply(campaign, replay)).toMatchObject({ result: { code: 'TARGET_CHANGED' } });
  campaign.changes.train!.expected = 100;
  expect(apply(campaign, replay)).toMatchObject({ result: { code: 'CAMPAIGN_FIELD' } });
  for (const invalid of [
    { kind: 'admin.general.rename', generalId: 1, name: '장수2' },
    { kind: 'admin.nation.rename', nationId: 1, name: '국가2' },
    { kind: 'admin.general.release', generalId: 1 },
    { kind: 'admin.nation.dismissOffice', nationId: 1, generalId: 2 },
    { kind: 'admin.city.adjust', cityKey: 1, changes: { population: { expected: 20000, value: 50001 } } },
    { kind: 'admin.general.adjust', generalId: 1, changes: { cityKey: { expected: 1, value: 99 } } },
  ] satisfies AdminGameAction[])
    expect(apply(invalid)).toMatchObject({ status: 'REJECTED', result: { code: 'INVALID_VALUE' } });
  for (const value of [1000, 9999])
    expect(
      apply({ kind: 'admin.general.adjust', generalId: 1, changes: { crewType: { expected: 1100, value } } }),
    ).toMatchObject({ result: { code: 'INVALID_VALUE' } });
  const maxed = fixture();
  maxed.revisions[1] = 2_147_483_647;
  expect(apply({ kind: 'admin.general.clearTurns', generalId: 1 }, maxed)).toMatchObject({
    result: { code: 'INVALID_VALUE' },
  });
});

it('AC-INT-23 재생은 변경 전후 위조·입력 종류 불일치·추가 키를 거부한다', () => {
  const replay = fixture();
  const action: AdminGameAction = {
    kind: 'admin.general.adjust',
    generalId: 1,
    changes: { gold: { expected: 100000, value: 123 } },
  };
  const outcome = apply(action, replay);
  const input: RecordedInput = {
    sequence: 1,
    tick: 10,
    generalId: null,
    kind: action.kind,
    payload: payload(action),
    status: outcome.status,
    result: outcome.result,
  };
  for (const tampered of [
    { ...input, result: { version: 1, before: { gold: 999 }, after: { gold: 123 } } },
    { ...input, result: { version: 1, before: { gold: 100000 }, after: { gold: 124 } } },
    { ...input, result: { version: 1, before: { gold: 100000 }, after: { gold: 123, rice: 0 } } },
    { ...input, kind: 'admin.city.adjust' },
    { ...input, generalId: 1 },
    { ...input, actorId: 'spoof' },
  ])
    expect(() => applyRecordedInput(replay, tampered)).toThrow();
  const rejected = { ...input, status: 'REJECTED' as const, result: { code: 'TARGET_CHANGED', message: '위조 문구' } };
  expect(() => applyRecordedInput(replay, rejected)).toThrow();
  const noResources = {
    kind: 'admin.general.adjust' as const,
    generalId: 1,
    changes: { crewType: { expected: 1100, value: 1200 } },
  };
  const withoutResources = { ...context };
  delete withoutResources.unitSet;
  expect(() => decideAdminGameAction(replay, payload(noResources), withoutResources)).toThrow('원생성');
});
