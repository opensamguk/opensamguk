import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { chooseNationTurn } from '../npc/index';
import { assignGeneral, respondAssignment } from './assignments';
import { expirePersonnelMonth } from './month';
import {
  runNpcPersonnelMonth,
  type NpcPersonnelInput,
  type NpcPersonnelResult,
  type ResidenceAnchors,
} from './npcMonth';
import type { OfficeState } from './offices';
import { completePersonnelStep } from './step';
import { applied, deepFreeze, personnelWorld } from './testFixture';
import { PersonnelInvariantError } from './types';

function world(): OfficeState {
  const state = personnelWorld();
  state.generals[1]!.userId = null;
  state.nations[1]!.gold = 0;
  state.nations[2]!.gold = 0;
  state.cities[1]!.connections = [4];
  state.cities[4]!.connections = [1, 2];
  return state;
}

function run(before = world(), tick = 70_000, anchors: ResidenceAnchors = { 3: 0, 4: 0 }): NpcPersonnelResult {
  return runNpcPersonnelMonth({ before, anchors, tick, raw: expirePersonnelMonth(before, {}, tick) });
}

function assignments(result: NpcPersonnelResult) {
  return result.decisions.filter((decision) => decision.kind === 'assign');
}

function addPerson(state: OfficeState, id: number, fields: Partial<OfficeState['generals'][number]> = {}): void {
  state.generals[id] = { ...state.generals[3]!, id, name: `장수${id}`, userId: `user${id}`, ...fields };
}

describe('NPC 군주의 월간 발령과 포상', () => {
  it.each([10_000, 40_000, 70_000, 100_000, 130_000])('1·4·7·10월 주기로 판단한다 (%i)', (tick) => {
    const state = world();
    state.nations[1]!.gold = 10_000;
    expect(run(state, tick).decisions.some((decision) => decision.kind === 'reward')).toBe(true);
  });

  it.each([20_000, 30_000, 50_000, 60_000, 80_000, 90_000, 110_000, 120_000])(
    '주기 밖에는 앵커를 읽지 않고 raw를 보존한다 (%i)',
    (tick) => {
      const state = world();
      state.nations[1]!.gold = 10_000;
      const raw = expirePersonnelMonth(state, {}, tick);
      const result = runNpcPersonnelMonth({ before: state, raw, anchors: {}, tick });
      expect(result).toEqual({ raw, history: [], decisions: [] });
      expect(result.raw.state).not.toBe(raw.state);
    },
  );

  it.each([0, -10_000, 10_001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '월 경계가 아니면 거부한다 (%s)',
    (tick) => {
      const state = world();
      const raw = expirePersonnelMonth(state, {}, 10_000);
      expect(() => runNpcPersonnelMonth({ before: state, raw, anchors: {}, tick })).toThrow();
    },
  );

  it('시작 상태와 P3의 시작 연도가 다르면 중단한다', () => {
    const state = world();
    const raw = expirePersonnelMonth(state, {}, 70_000);
    const changed = structuredClone(raw.state) as OfficeState;
    changed.startYear++;
    expect(() =>
      runNpcPersonnelMonth({ before: state, raw: { ...raw, state: changed }, anchors: {}, tick: 70_000 }),
    ).toThrow(PersonnelInvariantError);
  });

  it.each([
    [10_001, 0],
    [10_000, 0],
    [9_999, 1],
  ])('물리 체류 기간 60000tick을 엄격히 넘겨야 한다 (%i)', (anchor, count) => {
    expect(assignments(run(world(), 70_000, { 3: anchor, 4: anchor }))).toHaveLength(count);
  });

  it('직책과 무관하게 앵커가 이른 사람부터 고르고 동률은 장수 ID로 푼다', () => {
    const first = run(world(), 70_000, { 3: 5_000, 4: 0 });
    expect(assignments(first)[0]).toMatchObject({ generalId: 4, anchorTick: 0 });
    expect(assignments(run())[0]).toMatchObject({ generalId: 3, cityKey: 4 });
    expect(assignments(first)).toHaveLength(1);
  });

  it('미등장·재야·NPC·전선 거주·PENDING 보유자는 발령에서 제외한다', () => {
    const initial = world();
    initial.generals[3]!.activeFromYear = 999;
    initial.generals[4]!.nationId = null;
    addPerson(initial, 5, { cityKey: 4 });
    addPerson(initial, 6, { userId: null });
    addPerson(initial, 7);
    const state = applied(assignGeneral(initial, 1, 7, 4, 60_000)).state;
    expect(assignments(run(state, 70_000, { 3: 0, 5: 0, 7: 0 }))).toEqual([]);
  });

  it.each([null, 2])('무주 도시와 불가침 타국 도시도 전선으로 센다 (%s)', (owner) => {
    const state = world();
    state.cities[2]!.nationId = owner;
    state.diplomacies[0]!.state = 'NON_AGGRESSION';
    expect(assignments(run(state))[0]).toMatchObject({ cityKey: 4 });
  });

  it('가장 가까운 전선은 연결 목록 순서가 달라도 도시 ID로 고른다', () => {
    const state = world();
    state.cities[3]!.nationId = 1;
    state.cities[1]!.connections = [4, 3];
    state.cities[3]!.connections = [1, 2];
    expect(assignments(run(state))[0]).toMatchObject({ cityKey: 3 });
  });

  it('연결되지 않은 가장 오래된 후보를 건너뛰고 닿는 후보를 발령한다', () => {
    const state = world();
    state.cities[3]!.nationId = 1;
    state.cities[3]!.connections = [];
    state.generals[3]!.cityKey = 3;
    const result = run(state, 70_000, { 3: 0, 4: 1 });
    expect(assignments(result)[0]).toMatchObject({ generalId: 4, cityKey: 4 });
  });

  it('자기 영토로 닿는 전선이 없으면 제안과 기록을 만들지 않는다', () => {
    const state = world();
    state.cities[1]!.connections = [];
    const result = run(state);
    expect(result.decisions).toEqual([]);
    expect(result.history).toEqual([]);
    expect(result.raw.state.assignmentOffers).toBeUndefined();
  });

  it('P3 기한 수락으로 이동한 사람은 지금 도착한 것으로 읽는다', () => {
    const initial = world();
    initial.cities[3]!.nationId = 1;
    initial.cities[3]!.connections = [1];
    initial.cities[1]!.connections = [3, 4];
    initial.generals[4]!.userId = null;
    const before = applied(assignGeneral(initial, 1, 3, 3, 50_000)).state;
    const raw = expirePersonnelMonth(before, {}, 70_000);
    const result = runNpcPersonnelMonth({ before, raw, anchors: { 3: 0 }, tick: 70_000 });
    expect(result.raw.state.generals[3]!.cityKey).toBe(3);
    expect(assignments(result)).toEqual([]);
    expect(result.raw.closedOffers).toEqual(raw.closedOffers);
    expect(result.raw.logs.map((log) => log.commandKey)).toEqual(['offer.expire']);
  });

  it('U2가 앞선 제안을 취소해도 물리 앵커를 보존하고 새 제안을 한 번 만든다', () => {
    const initial = world();
    initial.cities[3]!.nationId = 1;
    const before = applied(assignGeneral(initial, 1, 3, 3, 60_000)).state;
    const settled = structuredClone(before);
    settled.cities[3]!.nationId = 2;
    const raw = expirePersonnelMonth(settled, {}, 70_000);
    const result = runNpcPersonnelMonth({ before, raw, anchors: { 3: 0, 4: 0 }, tick: 70_000 });
    expect(result.raw.closedOffers).toMatchObject([{ status: 'CANCELLED', cancelReason: 'CITY_LOST' }]);
    expect(assignments(result)).toMatchObject([{ generalId: 3, anchorTick: 0, cityKey: 4 }]);
    expect(result.raw.logs.map((log) => log.commandKey)).toEqual(['offer.cancel', 'nation_assign']);
    const packet = completePersonnelStep(before, {}, result.raw, 70_000);
    expect(packet.assignment.closedOffers).toEqual(raw.closedOffers);
    expect(packet.assignment.beforeFinish.assignmentOffers![3]!.id).toBe('70000-1-3');
    expect(packet.assignment.final).toEqual(packet.assignment.beforeFinish);
  });

  it('같은 도시 기한 수락은 물리 앵커를 새로 세지 않는다', () => {
    const before = applied(assignGeneral(world(), 1, 3, 1, 50_000)).state;
    const raw = expirePersonnelMonth(before, {}, 70_000);
    const result = runNpcPersonnelMonth({ before, raw, anchors: { 3: 0, 4: 0 }, tick: 70_000 });
    expect(assignments(result)).toMatchObject([{ generalId: 3, anchorTick: 0 }]);
    expect(result.raw.logs.map((log) => log.commandKey)).toEqual(['offer.expire', 'nation_assign']);
  });

  it('재야였던 체류를 포함하고 소속과 도시 소유가 바뀌어도 현재 후방이면 발령한다', () => {
    const before = world();
    before.generals[3]!.nationId = null;
    before.cities[1]!.nationId = 2;
    const settled = structuredClone(before);
    settled.generals[3]!.nationId = 1;
    settled.cities[1]!.nationId = 1;
    const raw = expirePersonnelMonth(settled, {}, 70_000);
    const result = runNpcPersonnelMonth({ before, raw, anchors: { 3: 0, 4: 0 }, tick: 70_000 });
    expect(assignments(result)).toMatchObject([{ generalId: 3, anchorTick: 0, fromCityKey: 1 }]);
    expect(result.history[0]!.text).toContain('같은 도시에 6개월 넘게 머물렀고 현재 후방에 있습니다.');
    expect(result.history[0]!.text).not.toContain('후방 체류');
  });

  it('발령 제안은 사람을 옮기지 않고 두 달 기한과 대상 로그를 남긴다', () => {
    const before = world();
    const result = run(before);
    expect(result.raw.state.assignmentOffers).toEqual({
      3: { id: '70000-1-3', nationId: 1, issuerGeneralId: 1, cityKey: 4, createdTick: 70_000, expiresTick: 90_000 },
    });
    expect(result.raw.state.generals).toEqual(before.generals);
    expect(result.raw.logs.map((log) => log.commandKey)).toEqual(['nation_assign']);
    expect(result.raw.closedOffers).toEqual([]);
    expect(completePersonnelStep(before, {}, result.raw, 70_000).assignment.final).toEqual({
      assignmentOffers: result.raw.state.assignmentOffers,
    });
  });

  it('실제 거절 뒤 다음 분기에는 쿨다운 없이 다시 제안한다', () => {
    const first = run();
    const rejected = applied(respondAssignment(first.raw.state, 3, '70000-1-3', false, 70_001));
    expect(rejected.state.generals[3]!.dedication).toBe(86);
    expect(assignments(run(rejected.state, 100_000))[0]).toMatchObject({ generalId: 3 });
  });

  it('현재 PENDING은 기한 전에 교체하지 않는다', () => {
    const before = applied(assignGeneral(world(), 1, 3, 4, 60_000)).state;
    const result = run(before);
    expect(result.raw.state.assignmentOffers![3]).toEqual(before.assignmentOffers![3]);
    expect(assignments(result)[0]).toMatchObject({ generalId: 4 });
  });

  it.each([9_999, 10_000, 12_400])('포상 기준을 한 번 판단하고 상위 세 명에게 각 금1000을 준다 (%i)', (gold) => {
    const state = world();
    state.cities[1]!.connections = [];
    state.nations[1]!.gold = gold;
    state.generals[3]!.dedication = 300;
    state.generals[4]!.dedication = 300;
    addPerson(state, 5, { dedication: 120 });
    addPerson(state, 6, { dedication: 0 });
    const result = run(state, 70_000, { 3: 0, 4: 0, 5: 0, 6: 0 });
    const recipients = gold >= 10_000 ? [3, 4, 5] : [];
    expect(result.decisions.map((decision) => decision.generalId)).toEqual(recipients);
    expect(result.raw.state.nations[1]!.gold).toBe(gold - recipients.length * 1000);
    for (const id of [3, 4, 5, 6]) {
      expect(result.raw.state.generals[id]!.gold).toBe(state.generals[id]!.gold + (recipients.includes(id) ? 1000 : 0));
      expect(result.raw.state.generals[id]!.rice).toBe(state.generals[id]!.rice);
    }
    expect(result.raw.state.nations[1]!.rice).toBe(state.nations[1]!.rice);
    expect(result.raw.logs).toEqual([]);
  });

  it('공헌0도 포상하고 미등장 사람과 NPC 장수는 제외한다', () => {
    const state = world();
    state.nations[1]!.gold = 10_000;
    state.generals[3]!.dedication = 0;
    state.generals[4]!.activeFromYear = 999;
    const result = run(state);
    expect(result.decisions.filter((decision) => decision.kind === 'reward')).toEqual([
      { kind: 'reward', nationId: 1, generalId: 3, gold: 1000 },
    ]);
  });

  it('기존 M1 군주 턴의 가난한 한 명 보충을 별도로 유지한다', () => {
    const state = world();
    state.nations[1]!.gold = 15_000;
    state.generals[3]!.gold = 0;
    const result = run(state);
    expect(result.raw.state.nations[1]!.gold).toBe(13_000);
    const choice = chooseNationTurn(result.raw.state, result.raw.state.generals[1]!, rngFor('npc-month', 'nation'), {
      tick: 70_000,
    });
    expect(choice.chosen).toMatchObject({
      key: 'nation_reward',
      args: { generalId: 3, resource: 'gold', amount: 9000 },
    });
  });

  it('국가 ID 순으로 발령 뒤 공헌 순 포상을 기록한다', () => {
    const state = world();
    state.nations[1]!.gold = 10_000;
    state.nations[2]!.gold = 10_000;
    state.generals[2]!.userId = null;
    state.cities[5] = { ...state.cities[1]!, cityKey: 5, nationId: 2, connections: [2] };
    state.cities[2]!.connections = [5, 4];
    addPerson(state, 5, { nationId: 2, cityKey: 5 });
    const result = run(state, 70_000, { 3: 0, 4: 0, 5: 0 });
    expect(result.decisions.map(({ kind, nationId }) => [nationId, kind])).toEqual([
      [1, 'assign'],
      [1, 'reward'],
      [1, 'reward'],
      [2, 'assign'],
      [2, 'reward'],
    ]);
    expect(result.history.map(({ nationId }) => nationId)).toEqual([1, 1, 1, 2, 2]);
    expect(result.history[0]!.text).toContain('발령');
  });

  it.each(['human', 'notNpc', 'missing'] as const)(
    '사람 군주·일반 국가·군주 없는 국가는 판단하지 않는다 (%s)',
    (kind) => {
      const state = world();
      if (kind === 'human') state.generals[1]!.userId = 'ruler';
      if (kind === 'notNpc') state.nations[1]!.isNpc = false;
      if (kind === 'missing') delete state.generals[1];
      expect(run(state, 70_000, {}).decisions).toEqual([]);
    },
  );

  it('군주가 중복되면 진행하지 않는다', () => {
    const state = world();
    state.generals[4]!.officerLevel = 12;
    expect(() => run(state)).toThrow(PersonnelInvariantError);
  });

  it.each([undefined, -1, 0.5, NaN, 70_001])('잘못된 물리 앵커를 기본값으로 채우지 않는다 (%s)', (anchor) => {
    const anchors: Record<number, number> = { 4: 0 };
    if (anchor !== undefined) anchors[3] = anchor;
    expect(() => run(world(), 70_000, anchors)).toThrow(PersonnelInvariantError);
  });

  it('월간 시작 상태에 없던 사람을 생성된 장수로 간주하지 않는다', () => {
    const before = world();
    const after = structuredClone(before);
    addPerson(after, 5);
    const raw = expirePersonnelMonth(after, {}, 70_000);
    expect(() => runNpcPersonnelMonth({ before, raw, anchors: { 3: 0, 4: 0, 5: 0 }, tick: 70_000 })).toThrow(
      PersonnelInvariantError,
    );
  });

  it('입력을 바꾸지 않고 같은 입력에 같은 결과를 내며 offices와 P3 기록을 보존한다', () => {
    const before = world();
    before.nations[1]!.gold = 10_000;
    const raw = expirePersonnelMonth(before, { 1: { 12: { revision: 2, tenure: 1 } } }, 70_000);
    const input: NpcPersonnelInput = { before, raw, anchors: { 3: 0, 4: 0 }, tick: 70_000 };
    const original = structuredClone(input);
    deepFreeze(input);
    const first = runNpcPersonnelMonth(input);
    expect(runNpcPersonnelMonth(input)).toEqual(first);
    expect(input).toEqual(original);
    expect(first.raw.offices).toEqual(raw.offices);
    expect(first.raw.offices).not.toBe(raw.offices);
    expect(first.history).toHaveLength(first.decisions.length);
  });
});
