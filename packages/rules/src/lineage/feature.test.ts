import { expect, it } from 'vitest';
import { commandInitial } from '../../test/commandFixture';
import { initialReplayState, applyRecordedInput } from '../replay';
import { settleMonthlyFeatures } from '../ruleRegistry';
import { enableReplayPolicy, assertReplayPolicy } from '../policy/replay';
import { lineageTestConfig } from './testFixture';
import { emptyLineagePerson } from './state';
import { successionPreview } from './preview';
import { decideLineageAction } from './actions';

function initial() {
  const value = commandInitial();
  value.ruleFeatures = ['personnel', 'lineage-v1'];
  for (const general of value.generals) {
    general.sex = general.id === 4 ? 'FEMALE' : 'MALE';
    general.crew = 0;
  }
  return value;
}
it('AC-P2-32 원생성 자료는 켠 판에서만 보관하고 성별 없는 원생성은 거부한다', () => {
  const old = initialReplayState(commandInitial());
  expect(Object.hasOwn(old, 'lineageResources')).toBe(false);
  expect(Object.hasOwn(old.state, 'lineage')).toBe(false);
  const value = initial(),
    replay = initialReplayState(value, { 'lineage-v1': lineageTestConfig });
  expect(replay.lineageResources).toEqual({
    statRules: value.statRules,
    unitSet: { defaultCrewTypeId: value.unitSet.defaultCrewTypeId },
  });
  delete value.generals[0]!.sex;
  expect(() => initialReplayState(value, { 'lineage-v1': lineageTestConfig })).toThrow();
});
it('AC-P2-32 정식 입력 재생은 동의한 자산·개인 칸·거주와 국가 직책을 함께 전환한다', () => {
  let replay = initialReplayState(initial(), { 'lineage-v1': lineageTestConfig });
  const world = replay.state;
  world.generals[1]!.userId = 'lineage-player';
  world.nations[1]!.isNpc = false;
  Object.assign(world.generals[3]!, { nationId: 1, cityKey: 1 });
  world.lineage!.persons['1'] = { ...emptyLineagePerson(), heirId: 3 };
  world.lineage!.persons['3'] = { ...emptyLineagePerson(), parents: [1, 4] };
  replay.offices = { 1: { 12: { revision: 8, tenure: 3 } } };
  replay.residenceAnchors = { 1: 5 };
  replay = enableReplayPolicy(replay, 60, 5);
  replay.state.ruleFeatures!.push('policy');
  replay.revisions[1] = 10;
  replay.revisions[3] = 5;
  const preview = successionPreview(replay.state, 1, 3, 100);
  if (!preview.ok) throw Error(preview.message);
  const payload = { type: 'succession.confirm' as const, heirGeneralId: 3, expected: preview.value };
  const outcome = decideLineageAction(replay.state, 1, payload, 100);
  if (!outcome.ok) throw Error(outcome.message);
  const before = structuredClone(replay),
    input = {
      sequence: 1,
      tick: 100,
      generalId: 1,
      kind: 'lineage.act',
      status: 'APPLIED' as const,
      payload,
      result: outcome.result,
    };
  const after = applyRecordedInput(replay, input);
  expect(replay).toEqual(before);
  expect(after.state.generals[3]).toMatchObject({
    userId: 'lineage-player',
    officerLevel: 12,
    gold: preview.value.gold,
    rice: preview.value.rice,
  });
  expect(after.revisions).toMatchObject({ 1: 11, 3: 11 });
  expect(after.residenceAnchors).toEqual({ 3: 100 });
  expect(after.offices?.[1]?.[12]).toEqual({ revision: 9, tenure: 4 });
  expect(after.state.officeTurns?.[1]?.[12]).toHaveLength(12);
  expect(() => assertReplayPolicy(after)).not.toThrow();
  expect(() => applyRecordedInput(replay, { ...input, result: { ...input.result, successorId: 4 } })).toThrow('재현');
});
it('AC-P2-32 월 정산 재생은 출생 행의 개인 칸·방침을 인사 정산보다 먼저 만든다', () => {
  const cfg = structuredClone(lineageTestConfig);
  cfg.marriage.npc.perMonth = 0;
  let replay = initialReplayState(initial(), { 'lineage-v1': cfg });
  Object.assign(replay.state.generals[4]!, { nationId: 1, cityKey: 1 });
  replay.state.lineage!.marriages = [{ id: 1, a: 1, b: 4, householdGeneralId: 1, sinceTick: 0 }];
  replay.state.lineage!.nextMarriageId = 2;
  replay = enableReplayPolicy(replay, 60, null);
  replay.state.ruleFeatures!.push('policy');
  const before = structuredClone(replay),
    tick = 10_000;
  const settled = settleMonthlyFeatures(replay, { ...replay, monthlyTick: tick }, tick);
  const newborn = settled.replay.state.generals[5]!;
  expect(newborn).toMatchObject({ id: 5, userId: null, crew: 0, gold: 0, rice: 0 });
  expect(settled.replay.turns[5]).toHaveLength(30);
  expect(settled.replay.revisions[5]).toBe(0);
  expect(() => assertReplayPolicy(settled.replay)).not.toThrow();
  expect(replay).toEqual(before);
  expect(settled.effects['lineage-v1']).toMatchObject({ births: [{ generalId: 5 }] });
});
