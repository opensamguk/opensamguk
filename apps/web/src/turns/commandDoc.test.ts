import { describe, expect, it } from 'vitest';
import { describeArgs, withTargets, type ArgNames } from './args';
import { commandAvailability, commandDoc, requirementsText, turnsText } from './commandDoc';
import type { CommandInfo } from './CommandPicker';

const base: CommandInfo = { key: 'farm', name: '농지 개간', category: 'domestic', argsSchema: {} };

describe('INT-26 AC-INT-26 명령 실행 가능 표시', () => {
  it('false만 흐리고 사유를 적는다. 사유가 비면 기본 문구를 쓴다', () => {
    expect(commandAvailability({ available: false, reason: ' 금이 부족합니다. ' })).toEqual({
      dimmed: true,
      reason: '금이 부족합니다.',
    });
    expect(commandAvailability({ available: false, reason: null })).toEqual({
      dimmed: true,
      reason: '지금은 실행할 수 없습니다.',
    });
  });

  it('null(인자 필요)·true·값 없음(옛 서버)은 흐리지 않는다', () => {
    expect(commandAvailability({ available: null, reason: '대상이나 값을 고르면 확인합니다.' })).toEqual({
      dimmed: false,
      reason: null,
    });
    expect(commandAvailability({ available: true, reason: null })).toEqual({ dimmed: false, reason: null });
    expect(commandAvailability({})).toEqual({ dimmed: false, reason: null });
  });
});

describe('INT-26 AC-INT-26 명령 도움말', () => {
  it('빈 값은 빼고 설명·비용·조건·소요 턴을 돌려준다', () => {
    expect(
      commandDoc({ ...base, description: '농업을 높입니다.', cost: '', requirements: ['자기 도시', ' '], turns: 1 }),
    ).toEqual({ description: '농업을 높입니다.', cost: null, requirements: ['자기 도시'], turns: 1 });
    expect(commandDoc(base)).toEqual({ description: null, cost: null, requirements: [], turns: null });
    expect(requirementsText(['자기 도시', '금 50'])).toBe('조건: 자기 도시 · 금 50');
    expect(requirementsText([])).toBeNull();
    expect(turnsText(2)).toBe('소요 2턴');
    expect(turnsText(null)).toBeNull();
  });
});

describe('INT-26 AC-INT-26 예턴 칸 대상 이름', () => {
  const names: ArgNames = { city: (key) => (key === 3 ? '낙양' : undefined), nation: () => undefined };

  it('칸의 대상 이름을 지도 이름보다 먼저 쓰고 장수 이름은 괄호를 뺀다', () => {
    const named = withTargets(names, { city: '허창', nation: '위', general: '조조(曹操)' });
    expect(describeArgs({ cityKey: 3 }, named)).toBe('허창');
    expect(describeArgs({ nationId: 2 }, named)).toBe('위');
    expect(describeArgs({ generalId: 7 }, named)).toBe('조조');
  });

  it('대상 이름이 없거나 null이면 지도 이름, 그것도 없으면 번호로 적는다', () => {
    expect(describeArgs({ cityKey: 3 }, withTargets(names, { city: null }))).toBe('낙양');
    expect(describeArgs({ cityKey: 4 }, withTargets(names, undefined))).toBe('도시 4');
    // 개인 칸에도 장수 대상이 있어 장수 번호를 `대상 장수 번호` 대신 `장수 N`으로 적는다.
    expect(describeArgs({ generalId: 7 }, withTargets(names, undefined))).toBe('장수 7');
    expect(describeArgs({ generalId: 7 }, withTargets(names, { general: null }))).toBe('장수 7');
    const listed = { ...names, general: (id: number) => (id === 7 ? '조운' : undefined) };
    expect(describeArgs({ generalId: 7 }, withTargets(listed, undefined))).toBe('조운');
  });
});
