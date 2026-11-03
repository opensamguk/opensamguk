import { expect, it } from 'vitest';
import { ruleRegistry } from '../ruleRegistry';
import { TICKS_PER_MONTH } from '../clock/constants';
import {
  heritageActivityMonths,
  HERITAGE_DIRECT_INPUT_KINDS,
  HERITAGE_IGNORED_INPUT_KINDS,
  type HeritageActivityInput,
} from './activity';

const input = (overrides: Partial<HeritageActivityInput> = {}): HeritageActivityInput => ({
  userId: 'account-a',
  kind: 'turns.set',
  status: 'APPLIED',
  sequence: 1,
  tick: 0,
  result: {},
  ...overrides,
});
it('AC-P2-33 등록된 입력을 수동 활동과 제외 항목 중 정확히 하나로 분류한다', () => {
  const direct = new Set<string>(HERITAGE_DIRECT_INPUT_KINDS),
    ignored = new Set<string>(HERITAGE_IGNORED_INPUT_KINDS);
  expect([...direct].filter((kind) => ignored.has(kind))).toEqual([]);
  for (const row of ruleRegistry.inputKinds)
    expect(Number(direct.has(row.kind)) + Number(ignored.has(row.kind)), row.kind).toBe(1);
});
it('AC-P2-33 수동 활동은 두 예턴 편집 경로 외에는 시각을 저장하는 공통 대기열을 거친다', () => {
  expect(
    HERITAGE_DIRECT_INPUT_KINDS.filter(
      (kind) => ruleRegistry.inputKinds.find((definition) => definition.kind === kind)?.route !== 'queued',
    ),
  ).toEqual(['turns.set', 'nationTurns.set']);
});
it('AC-P2-33 같은 계정의 전임자·후계자 입력은 한 달에 한 번만 센다', () => {
  const rows = [
    { ...input(), generalId: 5 },
    { ...input({ sequence: 2, tick: TICKS_PER_MONTH - 1 }), generalId: 7 },
    { ...input({ sequence: 3, tick: TICKS_PER_MONTH }), generalId: 7 },
    { ...input({ userId: 'account-b', sequence: 4 }), generalId: 8 },
  ];
  expect(heritageActivityMonths(rows, 4)).toEqual(
    new Map([
      ['account-a', 2],
      ['account-b', 1],
    ]),
  );
});
it('AC-P2-33 방침 직접 변경과 activeTick 예턴 편집은 세고 자동 활동·거절·종료 뒤 입력은 뺀다', () => {
  const rows = [
    input({ kind: 'general.setPolicy' }),
    input({ sequence: 2, tick: null, result: { activeTick: TICKS_PER_MONTH } }),
    ...HERITAGE_IGNORED_INPUT_KINDS.map((kind, i) => input({ kind, sequence: i + 3, tick: (i + 2) * TICKS_PER_MONTH })),
    input({ status: 'REJECTED', sequence: 50, tick: 50 * TICKS_PER_MONTH }),
    input({ status: 'PENDING', sequence: null, tick: null }),
    input({ sequence: 101, tick: 101 * TICKS_PER_MONTH }),
  ];
  expect(heritageActivityMonths(rows, 100).get('account-a')).toBe(2);
});
it('AC-P2-33 적용된 수동 입력의 순번·시각이 손상되면 지급 집계를 멈춘다', () => {
  expect(() => heritageActivityMonths([input({ sequence: null })], 1)).toThrow('입력 순번');
  expect(() => heritageActivityMonths([input({ tick: null, result: {} })], 1)).toThrow('활동 시각');
  expect(() => heritageActivityMonths([input({ tick: -1 })], 1)).toThrow('활동 시각');
});
