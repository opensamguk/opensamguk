import { describe, expect, it } from 'vitest';
import { calculateOperationForecast } from './forecast';
import { suggestOperationTurns, type OperationNoopCode } from './suggest';
import { directTurn, operationInput } from './testFixture';

describe('작전 제안 사본', () => {
  it.each([
    [0, 10],
    [9999, 10],
    [10000, 9],
  ])('오프셋 %i는 목표 전에 실행되는 마지막 칸 %i를 고른다', (nextTurnTick, slot) => {
    const result = suggestOperationTurns(operationInput({ nextTurnTick }));
    expect(result.noop).toBeNull();
    expect(result.slots[slot!]!.commandKey).toBe('attack');
    expect(result.changed).toEqual([slot]);
  });

  it('이른 목표 출병을 옮기고 마지막 출병 뒤 칸은 보존한다', () => {
    const input = operationInput();
    input.turns = input.turns.map((turn, i) => ([3, 15].includes(i) ? directTurn('attack', { cityKey: 2 }) : turn));
    const result = suggestOperationTurns(input);
    expect(result.slots[3]).toEqual(directTurn('rest'));
    expect(result.slots[15]).toEqual(input.turns[15]);
    expect(result.warnings).toContainEqual({
      slot: 3,
      code: 'SORTIE_MOVED',
      reason: '목표 도시 출병을 목표 전 마지막 칸으로 옮깁니다.',
    });
    expect(calculateOperationForecast({ ...input, turns: result.slots }).sortie?.slot).toBe(10);
  });

  it('준비 수의 고정점이 없어도 남는 칸을 직접 휴식으로 채워 READY를 만든다', () => {
    const input = operationInput({ deadlineTick: 20000, min: { crew: 100, train: 90, atmos: 90 } });
    input.turns = input.turns.map((turn, i) =>
      i === 0 ? directTurn('recruit', { amount: 100, crewType: 1100 }) : turn,
    );
    const result = suggestOperationTurns(input);
    expect(result.noop).toBeNull();
    expect(result.slots.slice(0, 2)).toEqual([directTurn('rest'), directTurn('attack', { cityKey: 2 })]);
    expect(result.changed).toEqual([0, 1]);
    expect(result.warnings.some((warning) => warning.slot === 0)).toBe(false);
    expect(calculateOperationForecast({ ...input, turns: result.slots }).verdict).toBe('READY');
  });

  it('블록 앞 모병을 보존하고 희석된 값에서 준비 수를 센다', () => {
    const input = operationInput({ min: { crew: 100, train: 90, atmos: 90 } });
    input.turns = input.turns.map((turn, i) =>
      i === 0 ? directTurn('recruit', { amount: 100, crewType: 1100 }) : turn,
    );
    const result = suggestOperationTurns(input);
    expect(result.slots[0]).toEqual(input.turns[0]);
    expect(result.slots.slice(2, 10).map((turn) => turn.commandKey)).toEqual([
      'train',
      'train',
      'train',
      'train',
      'morale',
      'morale',
      'morale',
      'morale',
    ]);
    expect(calculateOperationForecast({ ...input, turns: result.slots }).expected).toEqual({
      crew: 200,
      train: 90,
      atmos: 90,
    });
  });

  it('모병 희석과 증가량을 기존 준비 식으로 계산한다', () => {
    const input = operationInput({
      deadlineTick: 130000,
      current: { crew: 300, train: 90, atmos: 90 },
      min: { crew: 600, train: 90, atmos: 90 },
    });
    const result = suggestOperationTurns(input);
    expect(result.slots[1]).toEqual(directTurn('recruit', { amount: 300, crewType: 1100 }));
    expect(result.slots.filter((turn) => turn.commandKey === 'train')).toHaveLength(5);
    expect(result.slots.filter((turn) => turn.commandKey === 'morale')).toHaveLength(5);
    expect(calculateOperationForecast({ ...input, turns: result.slots }).expected).toEqual({
      crew: 600,
      train: 95,
      atmos: 95,
    });
  });

  it('훈련 95에서 100이면 한 칸만 넣고 이미 같은 출병은 changed에 넣지 않는다', () => {
    const input = operationInput({ current: { crew: 100, train: 95, atmos: 100 } });
    input.turns = input.turns.map((turn, i) => (i === 10 ? directTurn('attack', { cityKey: 2 }) : turn));
    const result = suggestOperationTurns(input);
    expect(result.changed).toEqual([9]);
    expect(result.slots[9]!.commandKey).toBe('train');
  });

  it.each<OperationNoopCode>(['NO_SLOT', 'BEYOND_WINDOW', 'NO_ROOM', 'UNREACHABLE'])(
    '%s는 원래 사본과 빈 변경·경고를 돌려준다',
    (code) => {
      const input = operationInput();
      if (code === 'NO_SLOT') input.deadlineTick = 0;
      if (code === 'BEYOND_WINDOW') input.deadlineTick = 300000;
      if (code === 'UNREACHABLE') input.min = { ...input.min, train: 101 };
      if (code === 'NO_ROOM') {
        input.deadlineTick = 20000;
        input.min = { crew: 600, train: 100, atmos: 100 };
      }
      const before = structuredClone(input);
      const result = suggestOperationTurns(input);
      expect(result.noop?.code).toBe(code);
      expect(result.slots).toEqual(input.turns);
      expect(result.changed).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(input).toEqual(before);
      expect(result.slots).not.toBe(input.turns);
    },
  );

  it('모병 명령 스키마 밖의 단일 모집량은 도달 불가이고 반복문이 커지지 않는다', () => {
    const input = operationInput({ min: { crew: 1000101, train: 0, atmos: 0 } });
    expect(suggestOperationTurns(input).noop?.code).toBe('UNREACHABLE');
  });

  it('현재 병종이 명령 인자를 통과하지 못하면 원래 칸을 보존한다', () => {
    const input = operationInput({ crewType: 0, min: { crew: 200, train: 0, atmos: 0 } });
    const result = suggestOperationTurns(input);
    expect(result.noop?.code).toBe('UNREACHABLE');
    expect(result.slots).toEqual(input.turns);
    expect(result.changed).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('손상된 큰 음수 훈련도 준비 칸 수를 넘어서 반복하지 않는다', () => {
    const input = operationInput({ current: { crew: 100, train: -2147483648, atmos: 100 } });
    expect(suggestOperationTurns(input).noop?.code).toBe('NO_ROOM');
  });

  it('모병 뒤의 훈련도 지금 상태로 검사해 조건부 NO_CREW 경고를 붙인다', () => {
    const input = operationInput({
      current: { crew: 0, train: 0, atmos: 0 },
      min: { crew: 100, train: 10, atmos: 10 },
    });
    const before = structuredClone(input);
    const result = suggestOperationTurns(input);
    const training = result.slots.findIndex((turn) => turn.commandKey === 'train');
    expect(result.warnings).toContainEqual(expect.objectContaining({ slot: training, code: 'NO_CREW' }));
    expect(calculateOperationForecast({ ...input, turns: result.slots }).verdict).toBe('READY');
    expect(input).toEqual(before);
  });

  it('원래 빈칸을 선택 명령으로 저장하지 않고 방침 예상만 재사용한다', () => {
    const input = operationInput({ current: { crew: 100, train: 95, atmos: 90 }, policy: 'drill' });
    const result = suggestOperationTurns(input);
    expect(result.changed).toEqual([10]);
    expect(result.slots[0]!.explicit).toBe(false);
    expect(result.slots[0]!.commandKey).toBe('rest');
    expect(calculateOperationForecast({ ...input, turns: result.slots }).verdict).toBe('READY');
  });
});
