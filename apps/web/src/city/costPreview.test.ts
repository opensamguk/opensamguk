import { recruitGoods } from '@opensamguk/rules/logistics-costs';
import { expect, it } from 'vitest';
import { readRecruitAmount, recruitPreview, shortGoods } from './costPreview';

// 서버가 준 모양의 고정물. 병종 이름과 병과 번호는 응답 값 그대로이며 화면은 번호의 뜻을 정하지 않는다.
const board = {
  recruitUnits: [
    { id: 1100, armType: 1, name: '보병' },
    { id: 1300, armType: 3, name: '기병' },
    { id: 9900, armType: 9, name: '설정 없는 병종' },
  ],
  costs: {
    recruitPer100: { '1': { iron: 2, wood: 0, horses: 0 }, '3': { iron: 2, wood: 0, horses: 10 } },
  },
  resources: { iron: 30, wood: 0, horses: 100, level: 1 },
} as unknown as Parameters<typeof recruitPreview>[0];

it('T4-93 AC-P2-30 모병 미리보기는 rules의 recruitGoods 결과와 같고 1..1,000,000 정수만 계산한다', () => {
  const preview = recruitPreview(board, '1300', '101');
  expect(preview).toEqual({
    kind: 'ready',
    per100: { iron: 2, wood: 0, horses: 10 },
    cost: recruitGoods(board.costs, 3, 101),
    short: [],
  });
  expect(preview.kind === 'ready' && preview.cost).toEqual({ iron: 4, wood: 0, horses: 20 });
  const max = recruitPreview(board, '1300', '1000000');
  expect(max.kind === 'ready' && max.cost).toEqual(recruitGoods(board.costs, 3, 1_000_000));
  expect(max.kind === 'ready' && max.short).toEqual([
    { good: 'iron', missing: 20_000 - 30 },
    { good: 'horses', missing: 100_000 - 100 },
  ]);
  for (const text of ['0', '-1', '1.5', '1e3', '1000001', 'abc'])
    expect(recruitPreview(board, '1300', text), text).toEqual({ kind: 'invalid' });
  expect(recruitPreview(board, '1300', '')).toEqual({ kind: 'idle' });
  expect(recruitPreview(board, '', '100')).toEqual({ kind: 'idle' });
  expect(recruitPreview(board, '1234', '100')).toEqual({ kind: 'idle' });
  // 비용 설정이 없는 병과는 rules를 부르지 않고 안내만 한다.
  expect(recruitPreview(board, '9900', '100')).toEqual({ kind: 'unknown' });
});

it('부족 재화는 모자란 양만 알리고 입력 읽기는 경계값을 지킨다', () => {
  expect(shortGoods({ iron: 10, wood: 50, horses: 0 }, { iron: 0, wood: 50, horses: 0 })).toEqual([]);
  expect(shortGoods({ iron: 10, wood: 49, horses: 0 }, { iron: 20, wood: 50, horses: 0 })).toEqual([
    { good: 'iron', missing: 10 },
    { good: 'wood', missing: 1 },
  ]);
  expect(readRecruitAmount(' ')).toBe('empty');
  expect(readRecruitAmount('1')).toBe(1);
  expect(readRecruitAmount('1000000')).toBe(1_000_000);
  expect(readRecruitAmount('1000001')).toBeNull();
});
