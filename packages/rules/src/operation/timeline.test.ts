import { describe, expect, it } from 'vitest';
import { rngFor } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { militaryCommands } from '../commands/military';
import { emptyTurns, type QueuedTurn } from '../replay';
import { calculateOperationTimeline, type OperationTimelineInput, type Readiness } from './timeline';

const attack = (cityKey = 2): QueuedTurn => ({ commandKey: 'attack', args: { cityKey } });
const recruit = (amount: number, commandKey = 'recruit'): QueuedTurn => ({
  commandKey,
  args: { amount, crewType: 1100 },
});
const drill = (commandKey: 'train' | 'morale'): QueuedTurn => ({ commandKey, args: {} });
function input(overrides: Partial<OperationTimelineInput> = {}): OperationTimelineInput {
  return {
    startYear: 191,
    nextTurnTick: 9999,
    deadlineTick: 10000,
    targetCityKey: 2,
    current: { crew: 100, train: 70, atmos: 80 },
    min: { crew: 100, train: 70, atmos: 80 },
    turns: [attack(), ...emptyTurns().slice(1)],
    ...overrides,
  };
}
function turns(...commands: QueuedTurn[]): QueuedTurn[] {
  return [...commands, ...emptyTurns().slice(commands.length)];
}
const readiness = ({ crew, train, atmos }: Readiness): Readiness => ({ crew, train, atmos });

describe('작전 타임라인 0단계', () => {
  it.each([
    [9999, 'READY'],
    [10000, 'LATE'],
    [10001, 'LATE'],
  ] as const)('출병 tick %i를 마감 10000과 비교하면 %s다', (nextTurnTick, verdict) => {
    expect(calculateOperationTimeline(input({ nextTurnTick })).verdict).toBe(verdict);
  });

  it.each(['crew', 'train', 'atmos'] as const)('%s가 기준보다 낮으면 WEAK다', (field) => {
    const current = { ...input().current, [field]: input().current[field] - 1 };
    expect(calculateOperationTimeline(input({ current })).verdict).toBe('WEAK');
    expect(calculateOperationTimeline(input({ current, nextTurnTick: 10000 })).verdict).toBe('LATE');
  });

  it('목표 도시의 첫 출병을 찾고 그 뒤의 준비는 예상값에 넣지 않는다', () => {
    const result = calculateOperationTimeline(
      input({ turns: turns(attack(3), drill('train'), attack(), recruit(100), attack()) }),
    );
    expect(result.sortie).toBe(result.cells[2]);
    expect(result.expected).toEqual({ crew: 100, train: 80, atmos: 80 });
  });

  it.each(
    [emptyTurns(), turns(attack(3)), turns({ commandKey: 'move', args: { cityKey: 2 } })].map((queued) => [queued]),
  )('목표 출병이 없으면 MISSING이다', (queued) => {
    const result = calculateOperationTimeline(input({ turns: queued }));
    expect(result.verdict).toBe('MISSING');
    expect(result.sortie).toBeNull();
  });

  it.each([null, [], {}, { cityKey: '2' }])('잘못된 출병 인자 %j는 목표 도시와 맞지 않는다', (args) => {
    const result = calculateOperationTimeline(input({ turns: turns({ commandKey: 'attack', args }) }));
    expect(result.sortie).toBeNull();
  });

  it('출병이 없으면 마지막 칸의 준비까지 예상값에 넣는다', () => {
    const queued = emptyTurns();
    queued[29] = drill('morale');
    expect(calculateOperationTimeline(input({ turns: queued })).expected.atmos).toBe(90);
  });

  it('30칸의 마지막 tick보다 마감이 뒤일 때만 beyondWindow다', () => {
    const lastTick = 9999 + 29 * 10000;
    for (const [deadlineTick, beyondWindow] of [
      [lastTick - 1, false],
      [lastTick, false],
      [lastTick + 1, true],
    ] as const) {
      const result = calculateOperationTimeline(input({ turns: emptyTurns(), deadlineTick }));
      expect(result.beyondWindow).toBe(beyondWindow);
      expect(result.verdict).toBe('MISSING');
    }
    const result = calculateOperationTimeline(input({ deadlineTick: lastTick + 1 }));
    expect(result.verdict).toBe('READY');
    expect(result.beyondWindow).toBe(true);
  });

  it('오프셋이 다른 장수 3명의 30칸 tick과 연월을 계산한다', () => {
    for (const nextTurnTick of [110000, 115000, 119999]) {
      const result = calculateOperationTimeline(input({ nextTurnTick }));
      expect(result.cells).toHaveLength(30);
      expect(result.cells.map(({ tick }) => tick)).toEqual(
        Array.from({ length: 30 }, (_, slot) => nextTurnTick + slot * 10000),
      );
      expect(result.cells[0]!.date).toEqual({ year: 191, month: 12 });
      expect(result.cells[1]!.date).toEqual({ year: 192, month: 1 });
      expect(result.cells[29]!.date).toEqual({ year: 194, month: 5 });
    }
  });

  it('목표 다음 달보다 늦은 출병도 칸과 연월을 남긴다', () => {
    const queued = emptyTurns();
    queued[29] = attack();
    const result = calculateOperationTimeline(input({ nextTurnTick: 0, turns: queued }));
    expect(result.verdict).toBe('LATE');
    expect(result.sortie).toMatchObject({ slot: 29, tick: 290000, date: { year: 193, month: 6 } });
  });

  it.each(['recruit', 'conscript'])('%s의 희석을 실제 명령 실행과 대조한다', (key) => {
    let state = commandWorld();
    Object.assign(state.generals[1]!, { crew: 137, train: 91, atmos: 87 });
    const initial = readiness(state.generals[1]!);
    const preparation = [recruit(211, key), drill('train'), drill('morale'), recruit(17, key)];
    for (const turn of preparation) {
      const command = militaryCommands.find(({ key }) => key === turn.commandKey)!;
      const result = command.execute(state, { generalId: 1, unitSet: testUnits }, turn.args, rngFor('operation'));
      state = applyEffects(state, result.effects);
    }
    const result = calculateOperationTimeline(input({ current: initial, turns: turns(...preparation, attack()) }));
    expect(result.expected).toEqual(readiness(state.generals[1]!));
    expect(result.expected).toEqual({ crew: 365, train: 42, atmos: 41 });
  });

  it('병력이 없을 때 모병하면 훈련과 사기는 0으로 희석된다', () => {
    const result = calculateOperationTimeline(
      input({ current: { crew: 0, train: 90, atmos: 80 }, turns: turns(recruit(100), attack()) }),
    );
    expect(result.expected).toEqual({ crew: 100, train: 0, atmos: 0 });
  });

  it('훈련과 사기 증가는 실제 명령과 같이 100에서 멈춘다', () => {
    let state = commandWorld();
    Object.assign(state.generals[1]!, { train: 95, atmos: 98 });
    const current = readiness(state.generals[1]!);
    for (const commandKey of ['train', 'morale'] as const) {
      const command = militaryCommands.find(({ key }) => key === commandKey)!;
      state = applyEffects(state, command.execute(state, { generalId: 1 }, {}, rngFor('cap')).effects);
    }
    const result = calculateOperationTimeline(input({ current, turns: turns(drill('train'), drill('morale')) }));
    expect(result.expected).toEqual(readiness(state.generals[1]!));
    expect(result.expected).toEqual({ crew: 10000, train: 100, atmos: 100 });
  });

  it('잘못된 준비 인자는 효과를 더하지 않는다', () => {
    const queued = turns(
      recruit(-1),
      recruit(0),
      recruit(1.5),
      recruit(1000001),
      { commandKey: 'conscript', args: { amount: 10 } },
      { commandKey: 'train', args: null },
      { commandKey: 'morale', args: { extra: true } },
    );
    expect(calculateOperationTimeline(input({ turns: queued })).expected).toEqual(input().current);
  });

  it('다른 명령과 자원 실행 검사를 예상값에 넣지 않는다', () => {
    const result = calculateOperationTimeline(
      input({ turns: turns({ commandKey: 'dismiss', args: {} }, recruit(1000000), drill('train')) }),
    );
    expect(result.expected).toEqual({ crew: 1000100, train: 10, atmos: 0 });
  });

  it('빈칸은 휴식으로 읽고 입력과 반환값 사이에 참조를 공유하지 않는다', () => {
    const source = input({ turns: [null, recruit(100), ...emptyTurns().slice(2)] });
    const before = structuredClone(source);
    const first = calculateOperationTimeline(source);
    expect(source).toEqual(before);
    expect(first.cells[0]!.turn).toEqual({ commandKey: 'rest', args: {} });
    expect(first).toEqual(calculateOperationTimeline(source));
    (first.cells[1]!.turn.args as { amount: number }).amount = 1;
    first.expected.crew = 1;
    expect(source).toEqual(before);
  });

  it.each([0, 29, 31])('예턴 %i칸 입력을 거부한다', (length) => {
    expect(() => calculateOperationTimeline(input({ turns: Array.from({ length }, () => null) }))).toThrow('30칸');
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('잘못된 첫 tick %s를 거부한다', (nextTurnTick) => {
    expect(() => calculateOperationTimeline(input({ nextTurnTick }))).toThrow();
  });

  it.each([-1, 0.5, NaN, Infinity])('잘못된 마감 tick %s를 거부한다', (deadlineTick) => {
    expect(() => calculateOperationTimeline(input({ deadlineTick }))).toThrow('마감 tick');
  });
});
