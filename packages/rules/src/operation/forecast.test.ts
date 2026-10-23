import { describe, expect, it } from 'vitest';
import { calculateOperationTimeline } from './timeline';
import { calculateOperationForecast } from './forecast';
import { directTurn, operationInput } from './testFixture';

describe('작전 방침 예상', () => {
  it('방침이 없으면 기존 타임라인과 같다', () => {
    const input = operationInput();
    input.turns = input.turns.map((turn, i) => (i === 5 ? directTurn('attack', { cityKey: 2 }) : turn));
    expect(calculateOperationForecast(input)).toEqual(calculateOperationTimeline(input));
  });

  it('예상 훈련이 100에 닿으면 다음 빈칸은 실제 선택 함수로 사기진작을 고른다', () => {
    const input = operationInput({
      current: { crew: 100, train: 95, atmos: 80 },
      policy: 'drill',
      min: { crew: 100, train: 100, atmos: 90 },
    });
    input.turns = input.turns.map((turn, i) => (i === 2 ? directTurn('attack', { cityKey: 2 }) : turn));
    const before = structuredClone(input);
    const result = calculateOperationForecast(input);
    expect(result.expected).toEqual({ crew: 100, train: 100, atmos: 90 });
    expect(result.verdict).toBe('READY');
    expect(result.sortie).toBe(result.cells[2]);
    expect(result.cells[0]!.turn).toEqual({ commandKey: 'rest', args: {}, explicit: false });
    expect(input).toEqual(before);
  });

  it('직접 휴식은 훈련 방침으로 바꾸지 않는다', () => {
    const input = operationInput({ current: { crew: 100, train: 95, atmos: 100 }, policy: 'drill' });
    input.turns = input.turns.map((turn, i) =>
      i === 0 ? directTurn('rest') : i === 1 ? directTurn('attack', { cityKey: 2 }) : turn,
    );
    expect(calculateOperationForecast(input).expected.train).toBe(95);
    expect(calculateOperationForecast(input).verdict).toBe('WEAK');
  });

  it.each(['legacy', 'npc'] as const)('%s에서는 빈칸을 휴식으로 읽는다', (kind) => {
    const input = operationInput({
      current: { crew: 100, train: 95, atmos: 100 },
      policy: 'drill',
      policyMode: kind !== 'legacy',
    });
    if (kind === 'npc')
      input.view = {
        ...input.view,
        generals: { ...input.view.generals, 1: { ...input.view.generals[1]!, userId: null } },
      };
    input.turns = input.turns.map((turn, i) => (i === 1 ? directTurn('attack', { cityKey: 2 }) : turn));
    expect(calculateOperationForecast(input).expected.train).toBe(95);
  });

  it('보존한 모병의 희석 뒤 값을 방침 선택에 쓴다', () => {
    const input = operationInput({ policy: 'drill' });
    input.turns = input.turns.map((turn, i) =>
      i === 0
        ? directTurn('recruit', { amount: 100, crewType: 1100 })
        : i === 2
          ? directTurn('attack', { cityKey: 2 })
          : turn,
    );
    expect(calculateOperationForecast(input).expected).toEqual({ crew: 200, train: 60, atmos: 50 });
  });

  it('빈칸 방침은 자원 실패를 실행하지 않는 예상이며 첫 출병 뒤 준비는 세지 않는다', () => {
    const input = operationInput({
      current: { crew: 0, train: 95, atmos: 0 },
      policy: 'drill',
      min: { crew: 0, train: 100, atmos: 0 },
    });
    input.turns = input.turns.map((turn, i) => (i === 1 ? directTurn('attack', { cityKey: 2 }) : turn));
    expect(calculateOperationForecast(input).expected).toEqual({ crew: 0, train: 100, atmos: 0 });
  });
});
