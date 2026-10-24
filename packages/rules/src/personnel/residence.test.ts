import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { buildCreatedGeneral } from '../general/create';
import { testUnits } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { runCommand } from '../commands/registry';
import { removeNation } from '../commands/support';
import { assignGeneral, respondAssignment } from './assignments';
import { applyNationTurnsRecord } from './inputs';
import type { OfficeState, OfficeView } from './offices';
import { updateResidenceAnchors, type ResidenceStepInput } from './residence';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

function input(): ResidenceStepInput {
  const before = personnelWorld();
  return { before, after: structuredClone(before), anchors: { 3: 5, 4: 10 }, tick: 100, createdHumanId: null };
}

function createHuman(before: OfficeView, tick: number) {
  return buildCreatedGeneral({
    payload: { name: '새장수', leadership: 70, strength: 70, intel: 60, portraitId: null },
    seed: 'residence-created',
    userId: 'created',
    id: 5,
    startYear: before.startYear,
    monthlyTick: 0,
    tick,
    cityKeys: Object.keys(before.cities).map(Number),
    unitSet: testUnits,
  });
}

describe('사람 장수의 물리 거주 앵커', () => {
  it('실제 이동한 장수만 현재 tick으로 갱신한다', () => {
    const step = input();
    const after = structuredClone(step.after) as OfficeState;
    after.generals[3]!.cityKey = 4;
    expect(updateResidenceAnchors({ ...step, after })).toEqual({ 3: 100, 4: 10 });
  });

  it('실제 이동 명령의 최종 도시를 기록한다', () => {
    const before = personnelWorld();
    before.cities[1]!.connections = [4];
    const result = runCommand(before, { generalId: 3, tick: 100 }, 'move', { cityKey: 4 }, rngFor('residence-move'));
    if ('code' in result) throw new Error(result.message);
    const after = applyEffects(before, result.effects);
    expect(after.generals[3]!.cityKey).toBe(4);
    expect(
      updateResidenceAnchors({ before, after, anchors: { 3: 5, 4: 10 }, tick: 100, createdHumanId: null }),
    ).toEqual({ 3: 100, 4: 10 });
  });

  it('실패한 이동에는 새 도착 시각을 만들지 않는다', () => {
    const step = input();
    const result = runCommand(
      step.before,
      { generalId: 3, tick: 100 },
      'move',
      { cityKey: 999 },
      rngFor('residence-fail'),
    );
    expect(result).toHaveProperty('code');
    expect(updateResidenceAnchors(step)).toEqual(step.anchors);
  });

  it('같은 도시 발령 수락에는 도착 시각을 바꾸지 않는다', () => {
    const before = applied(assignGeneral(personnelWorld(), 4, 3, 1, 20)).state;
    const after = applied(respondAssignment(before, 3, '20-4-3', true, 100)).state;
    expect(
      updateResidenceAnchors({ before, after, anchors: { 3: 5, 4: 10 }, tick: 100, createdHumanId: null }),
    ).toEqual({ 3: 5, 4: 10 });
  });

  it('소유·소속·직책·국가 멸망은 같은 도시의 도착 시각을 바꾸지 않는다', () => {
    const step = input();
    const after = structuredClone(step.after) as OfficeState;
    after.cities[1]!.nationId = 2;
    after.generals[3]!.officerLevel = 7;
    removeNation(after, 1);
    expect(updateResidenceAnchors({ ...step, after })).toEqual(step.anchors);
  });

  it('생성105 뒤 즉시 칸 편집100은 기존 앵커105를 보존한다', () => {
    const step = input();
    const created = structuredClone(step.before) as OfficeState;
    created.generals[5] = createHuman(step.before, 105);
    const anchors = updateResidenceAnchors({ ...step, after: created, tick: 105, createdHumanId: 5 });
    const edited = applyNationTurnsRecord(
      created,
      {},
      {
        kind: 'nationTurns.set',
        status: 'APPLIED',
        sequence: 1,
        generalId: 4,
        payload: {
          office: { nationId: 1, officerLevel: 5, tenure: 0 },
          revision: 0,
          turns: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
        },
        result: { revision: 1 },
      },
    );
    expect(
      updateResidenceAnchors({ before: created, after: edited.state, anchors, tick: 100, createdHumanId: null }),
    ).toEqual({ 3: 5, 4: 10, 5: 105 });
  });

  it('입력105 뒤 밀린 턴102에서 이동하면 실제 턴 tick을 기록한다', () => {
    const before = applied(assignGeneral(personnelWorld(), 4, 3, 4, 20)).state;
    before.cities[4]!.connections = [1];
    const accepted = applied(respondAssignment(before, 3, '20-4-3', true, 105)).state;
    const anchors = updateResidenceAnchors({
      before,
      after: accepted,
      anchors: { 3: 5, 4: 10 },
      tick: 105,
      createdHumanId: null,
    });
    expect(anchors).toEqual({ 3: 105, 4: 10 });
    const result = runCommand(accepted, { generalId: 3, tick: 102 }, 'move', { cityKey: 1 }, rngFor('overdue-move'));
    if ('code' in result) throw new Error(result.message);
    const after = applyEffects(accepted, result.effects);
    expect(after.generals[3]!.cityKey).toBe(1);
    expect(updateResidenceAnchors({ before: accepted, after, anchors, tick: 102, createdHumanId: null })).toEqual({
      3: 102,
      4: 10,
    });
  });

  it.each([0, 105])('실제 생성한 사람에게 생성 tick을 기록한다 (%i)', (tick) => {
    const step = input();
    const after = structuredClone(step.after) as OfficeState;
    after.generals[5] = createHuman(step.before, tick);
    expect(updateResidenceAnchors({ ...step, after, tick, createdHumanId: 5 })).toEqual({ 3: 5, 4: 10, 5: tick });
  });

  it('생성 출처가 없거나 잘못된 ID면 새 사람 앵커를 추정하지 않는다', () => {
    const step = input();
    const after = structuredClone(step.after) as OfficeState;
    after.generals[5] = { ...after.generals[3]!, id: 5, userId: 'new' };
    expect(() => updateResidenceAnchors({ ...step, after })).toThrow(PersonnelInvariantError);
    expect(() => updateResidenceAnchors({ ...step, after, createdHumanId: 6 })).toThrow(PersonnelInvariantError);
    expect(() => updateResidenceAnchors({ ...step, after, createdHumanId: 3 })).toThrow(PersonnelInvariantError);
  });

  it('기존 NPC를 사람으로 바꾼 앵커를 생성 tick으로 가장하지 않는다', () => {
    const step = input();
    const after = structuredClone(step.after) as OfficeState;
    after.generals[1]!.userId = 'possessed';
    expect(() => updateResidenceAnchors({ ...step, after })).toThrow(PersonnelInvariantError);
    expect(() => updateResidenceAnchors({ ...step, after, createdHumanId: 1 })).toThrow(PersonnelInvariantError);
  });

  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])('저장할 수 없는 처리 tick은 거부한다 (%s)', (tick) => {
    expect(() => updateResidenceAnchors({ ...input(), tick })).toThrow(PersonnelInvariantError);
  });

  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])('저장할 수 없는 앵커는 보정하지 않는다 (%s)', (anchor) => {
    expect(() => updateResidenceAnchors({ ...input(), anchors: { 3: anchor, 4: 10 } })).toThrow(
      PersonnelInvariantError,
    );
  });

  it.each([{}, { 3: 5 }, { 3: 5, 4: 10, 1: 0 }, { 3: 5, 4: 10, 999: 0 }, { '03': 5, 4: 10 }])(
    '누락·NPC·고아·비정규 장수 키를 허용하지 않는다 (%j)',
    (anchors) => {
      expect(() => updateResidenceAnchors({ ...input(), anchors })).toThrow(PersonnelInvariantError);
    },
  );

  it('NPC만 있으면 빈 map을 만들고 NPC 이동에 앵커를 만들지 않는다', () => {
    const before = personnelWorld();
    for (const general of Object.values(before.generals)) general.userId = null;
    const after = structuredClone(before);
    after.generals[1]!.cityKey = 4;
    expect(updateResidenceAnchors({ before, after, anchors: {}, tick: 100, createdHumanId: null })).toEqual({});
  });

  it('입력과 map을 바꾸지 않고 같은 입력에 같은 새 map을 돌려준다', () => {
    const step = input();
    const saved = structuredClone(step);
    deepFreeze(step);
    const first = updateResidenceAnchors(step);
    expect(updateResidenceAnchors(step)).toEqual(first);
    expect(first).not.toBe(step.anchors);
    expect(step).toEqual(saved);
  });
});
