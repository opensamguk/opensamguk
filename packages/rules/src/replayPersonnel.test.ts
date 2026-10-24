import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandInitial, testUnits } from '../test/commandFixture';
import { TICKS_PER_MONTH } from './clock/constants';
import { createCommandResolver } from './commands/resolve';
import { runGeneralTurn } from './commands/turn';
import { monthlyDate, runMonthly } from './monthly';
import { assignGeneral } from './personnel/assignments';
import { completePersonnelStep } from './personnel/step';
import { applied, deepFreeze, personnelWorld } from './personnel/testFixture';
import { emptyTurn } from './policy';
import { enableReplayPolicy } from './policy/replay';
import { initialReplayState, runReplayAction, type ReplayState } from './replay';

const seed = 'replay-office-contract';
const rest = { commandKey: 'rest', args: {} };
const nationRest = { commandKey: 'nation_rest', args: {} };

function officeReplay(): ReplayState {
  const replay = initialReplayState(commandInitial());
  replay.state = personnelWorld();
  for (const general of Object.values(replay.state.generals)) general.nextTurnTick = 5000;
  replay.state.generals[4]!.nextTurnTick = 100;
  replay.state.officeTurns = { 1: { 5: Array.from({ length: 12 }, () => structuredClone(nationRest)) } };
  replay.offices = { 1: { 5: { revision: 7, tenure: 2 }, 12: { revision: 4, tenure: 1 } } };
  replay.revisions[4] = 5;
  return replay;
}

describe('인사 재생의 순수 턴 연결', () => {
  it.each([false, true])('턴 뒤 마무리와 개인 칸 갱신을 같은 순서로 적용한다 (방침 %s)', (policy) => {
    let replay = officeReplay();
    if (policy) replay = enableReplayPolicy(replay, 30, 0);
    replay.state.officeTurns![1]![5]![0] = {
      commandKey: 'nation_reward',
      args: { generalId: 3, resource: 'gold', amount: 10 },
    };
    replay.turns[4]![0] = { commandKey: 'farm', args: {}, explicit: true };
    const before = structuredClone(replay);
    const raw = runGeneralTurn(
      replay.state,
      { generalId: 4, tick: 100, unitSet: testUnits },
      replay.turns[4]![0]!,
      seed,
      policy ? { policy: replay.policy!.policies[4]! } : {},
      undefined,
      { offices: replay.offices! },
    );
    raw.state.generals[4]!.nextTurnTick += TICKS_PER_MONTH;
    const packet = completePersonnelStep(replay.state, replay.offices!, { state: raw.state, ...raw.personnel! }, 100);
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(next.state).toEqual(packet.state);
    expect(next.offices).toEqual(packet.offices);
    expect(next.offices![1]![5]).toEqual({ revision: 8, tenure: 2 });
    expect(next.offices![1]![12]).toEqual(before.offices![1]![12]);
    expect(next.state.generals[3]!.gold).toBe(before.state.generals[3]!.gold + 10);
    expect(next.state.cities[1]!.agriculture).toBeGreaterThan(before.state.cities[1]!.agriculture);
    expect(next.state.generals[4]!.nextTurnTick).toBe(10100);
    expect(next.turns[4]).toEqual([...before.turns[4]!.slice(1), policy ? emptyTurn() : rest]);
    expect(next.revisions[4]).toBe(6);
    expect(next.revisions[1]).toBe(before.revisions[1]);
    expect(next.policy).toEqual(before.policy);
    expect(next.monthlyTick).toBe(0);
    expect(Object.hasOwn(next, 'personnel')).toBe(false);
    expect(replay).toEqual(before);
  });

  it('국가 발령 뒤 개인 하야는 제안을 취소하고 소비와 직책 변경을 함께 반영한다', () => {
    const replay = officeReplay();
    replay.state.officeTurns![1]![5]![0] = {
      commandKey: 'nation_assign',
      args: { generalId: 3, cityKey: 4 },
    };
    replay.turns[4]![0] = { commandKey: 'resign', args: {} };
    const before = structuredClone(replay);
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(next.offices![1]![5]).toEqual({ revision: 9, tenure: 3 });
    expect(next.offices![1]![12]).toEqual(before.offices![1]![12]);
    expect(next.state.officeTurns![1]![5]).toEqual(Array.from({ length: 12 }, () => nationRest));
    expect(Object.hasOwn(next.state, 'assignmentOffers')).toBe(false);
    expect(next.state.generals[4]).toMatchObject({ nationId: null, officerLevel: 0, nextTurnTick: 10100 });
    expect(next.state.generals[3]!.cityKey).toBe(1);
    expect(next.revisions[4]).toBe(6);
    expect(replay).toEqual(before);
  });

  it('방침 조기 반환 뒤에도 유효하지 않은 제안을 닫고 칸 소비를 한 번 반영한다', () => {
    let replay = officeReplay();
    replay.state = applied(assignGeneral(replay.state, 4, 3, 4, 50)).state;
    replay.state.cities[4]!.nationId = 2;
    replay = enableReplayPolicy(replay, 30, 0);
    const before = structuredClone(replay);
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(next.offices![1]![5]).toEqual({ revision: 8, tenure: 2 });
    expect(Object.hasOwn(next.state, 'assignmentOffers')).toBe(false);
    expect(next.policy).toEqual(before.policy);
    expect(next.turns[4]![29]).toEqual(emptyTurn());
    expect(next.state.generals[4]!.nextTurnTick).toBe(10100);
    expect(next.revisions[4]).toBe(6);
    expect(replay).toEqual(before);
  });

  it('직책자가 아닌 장수의 턴도 마무리하며 직책 카운터는 소비하지 않는다', () => {
    const replay = officeReplay();
    replay.state = applied(assignGeneral(replay.state, 1, 3, 4, 50)).state;
    replay.state.generals[4]!.officerLevel = 1;
    replay.state.cities[4]!.nationId = 2;
    const before = structuredClone(replay);
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(next.offices).toEqual(before.offices);
    expect(next.state.officeTurns).toEqual(before.state.officeTurns);
    expect(Object.hasOwn(next.state, 'assignmentOffers')).toBe(false);
    expect(next.state.generals[4]!.nextTurnTick).toBe(10100);
    expect(replay).toEqual(before);
  });

  it('빈 카운터는 첫 소비를 기록하고 없는 직책 칸 키는 만들지 않는다', () => {
    const replay = officeReplay();
    replay.offices = {};
    delete replay.state.officeTurns;
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(next.offices).toEqual({ 1: { 5: { revision: 1, tenure: 0 } } });
    expect(Object.hasOwn(next.state, 'officeTurns')).toBe(false);
    expect(Object.hasOwn(next.state, 'assignmentOffers')).toBe(false);
  });

  it('월간 갈래는 기존 월간 결과와 offices를 보존하고 인사 마무리를 붙이지 않는다', () => {
    const replay = officeReplay();
    replay.state = applied(assignGeneral(replay.state, 4, 3, 4, 50)).state;
    replay.state.cities[4]!.nationId = 2;
    for (const general of Object.values(replay.state.generals)) general.nextTurnTick = TICKS_PER_MONTH;
    const before = structuredClone(replay);
    const date = monthlyDate(replay.state.startYear, TICKS_PER_MONTH);
    const expected = runMonthly(replay.state, TICKS_PER_MONTH, rngFor(seed, 'monthly', date.year, date.month));
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(next).toEqual({ ...before, state: expected.state, monthlyTick: TICKS_PER_MONTH });
    expect(next.offices).toBe(replay.offices);
    expect(next.state.assignmentOffers).toEqual(before.state.assignmentOffers);
    expect(next.state.officeTurns).toEqual(before.state.officeTurns);
    expect(replay).toEqual(before);
  });

  it.each([
    [5, undefined],
    [5, null],
    [1, undefined],
    [1, null],
  ])('직책 %s의 손상된 offices 값(%s)을 빈 카운터로 고치지 않는다', (level, offices) => {
    const replay = officeReplay();
    replay.state.generals[4]!.officerLevel = level!;
    Object.assign(replay, { offices });
    const before = structuredClone(replay);
    expect(() => runReplayAction(deepFreeze(replay), seed, testUnits)).toThrow();
    expect(replay).toEqual(before);
  });

  it.each([{}, undefined])('인사 턴에 남은 국가 예턴 키를 거부한다 (%j)', (nationTurns) => {
    const replay = officeReplay();
    Object.assign(replay.state, { nationTurns });
    const before = structuredClone(replay);
    expect(() => runReplayAction(deepFreeze(replay), seed, testUnits)).toThrow(
      '인사 기능을 켠 월드에 국가 예턴이 있습니다.',
    );
    expect(replay).toEqual(before);
  });

  it('기존 unitSet·resolver 자리와 메서드 수신자·난수 이름을 보존한다', () => {
    const replay = officeReplay();
    replay.state.officeTurns![1]![5]![0] = {
      commandKey: 'nation_reward',
      args: { generalId: 3, resource: 'gold', amount: 10 },
    };
    const base = createCommandResolver(null);
    const calls: { key: string; firstRandom: number }[] = [];
    const resolver = {
      ...base,
      run(...args: Parameters<typeof base.run>) {
        expect(this).toBe(resolver);
        expect(args[1].unitSet).toBe(testUnits);
        expect(args[1].tick).toBe(100);
        expect(args[0].generals[4]!.officerLevel).toBe(5);
        expect(args[1].authority).toBe(args[2] === 'nation_reward' ? 'office' : undefined);
        // 포상과 휴식은 난수를 쓰지 않으므로 첫 값 관측 뒤 실제 명령을 실행한다.
        calls.push({ key: args[2], firstRandom: args[4].next() });
        return base.run(...args);
      },
    };
    const next = runReplayAction(deepFreeze(replay), seed, testUnits, resolver);
    expect(calls).toEqual([
      { key: 'nation_reward', firstRandom: rngFor(seed, 'nation-turn', 100, 1).next() },
      { key: 'rest', firstRandom: rngFor(seed, 'turn', 100, 4).next() },
    ]);
    expect(next.offices![1]![5]).toEqual({ revision: 8, tenure: 2 });
    expect(next).toEqual(runReplayAction(replay, seed, testUnits));
  });
});

describe('인사 offices 키가 없는 기존 재생', () => {
  it.each([false, true])('초기화와 턴 결과에 인사 키를 붙이지 않는다 (방침 %s)', (policy) => {
    let replay = initialReplayState(commandInitial());
    if (policy) replay = enableReplayPolicy(replay, 30, null);
    const next = runReplayAction(deepFreeze(replay), seed, testUnits);
    expect(Object.keys(next).sort()).toEqual(Object.keys(replay).sort());
    for (const value of [replay, next]) {
      expect(Object.hasOwn(value, 'offices')).toBe(false);
      expect(Object.hasOwn(value, 'personnel')).toBe(false);
      expect(Object.hasOwn(value.state, 'officeTurns')).toBe(false);
      expect(Object.hasOwn(value.state, 'assignmentOffers')).toBe(false);
    }
  });

  it('상속된 offices 값으로 인사 갈래를 켜지 않는다', () => {
    const replay = initialReplayState(commandInitial());
    const expected = runReplayAction(replay, seed, testUnits);
    Object.setPrototypeOf(replay, { offices: {} });
    const next = runReplayAction(replay, seed, testUnits);
    expect(next).toEqual(expected);
    expect(Object.hasOwn(next, 'offices')).toBe(false);
  });
});
