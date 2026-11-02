import { expect, it } from 'vitest';
import {
  dispatchCheck,
  lossPercent,
  readCount,
  readOnlyReason,
  tradeCheck,
  upgradeCheck,
  type OwnLogisticsBoard,
} from './logistics';

// 화면 안내만 시험한다. 수치는 모두 서버가 준 값이라고 가정한 고정물이다.
function board(overrides: Partial<OwnLogisticsBoard> = {}): OwnLogisticsBoard {
  return {
    userId: 'u1',
    cityKey: 30,
    visible: true,
    own: true,
    status: 'RUNNING',
    canManage: true,
    settling: false,
    tick: 1210,
    revision: 4,
    specialty: { cityKey: 30, good: 'wood', perMonth: 600 },
    resources: { iron: 4200, wood: 9800, horses: 1500, level: 1 },
    capacity: 20000,
    used: 15500,
    gold: 12400,
    costs: {
      upgrade: { gold: 1000, wood: 500 },
      capacity: { base: 10000, perLevel: 10000, maxLevel: 5 },
      trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 2, sell: 1 }, horses: { buy: 5, sell: 2 } },
      recruitPer100: {},
      build: { wall: { iron: 0, wood: 50, horses: 0 }, defence: { iron: 20, wood: 20, horses: 0 } },
      transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 100000, maxActivePerNation: 20 },
    },
    destinations: [{ cityKey: 28, name: '완', freeCapacity: 100, path: [30, 29, 28], arriveTick: 1300, lossBp: 200 }],
    convoys: [],
    movements: [],
    ...overrides,
  } as OwnLogisticsBoard;
}

it('T4-93 AC-P2-30 보내기는 서버 재고·한도로 막고 도착지 여유 부족은 막지 않고 알린다', () => {
  const draft = { to: '28', iron: '', wood: '500', horses: '' };
  const ok = dispatchCheck(board(), draft);
  expect(ok.reasons).toEqual([]);
  expect(ok.overflowRisk).toBe(true);
  expect(ok.payload).toEqual({
    type: 'dispatch',
    fromCityKey: 30,
    toCityKey: 28,
    goods: { iron: 0, wood: 500, horses: 0 },
  });
  expect(dispatchCheck(board(), { ...draft, to: '' }).payload).toBeNull();
  expect(dispatchCheck(board(), { ...draft, wood: '0' }).reasons).toContain('보낼 재화를 하나 이상 넣으세요.');
  expect(dispatchCheck(board(), { ...draft, wood: '9801' }).reasons).toContain('목재는 9,800까지 보낼 수 있습니다.');
  expect(dispatchCheck(board(), { ...draft, wood: '1.5' }).payload).toBeNull();
  expect(dispatchCheck(board(), { ...draft, wood: '-1' }).payload).toBeNull();
  const full = board({ convoys: Array.from({ length: 20 }, () => ({}) as OwnLogisticsBoard['convoys'][number]) });
  expect(dispatchCheck(full, draft).payload).toBeNull();
});

it('증축과 교역은 서버 비용·가격만 쓰고 32비트 최대값 곱도 정확히 비교한다', () => {
  expect(upgradeCheck(board()).payload).toEqual({ type: 'upgrade', cityKey: 30 });
  expect(upgradeCheck(board()).nextCapacity).toBe(30000);
  expect(upgradeCheck(board({ gold: 999 })).reasons).toEqual(['도시 금이 1 부족합니다.']);
  expect(upgradeCheck(board({ resources: { iron: 0, wood: 0, horses: 0, level: 5 } })).payload).toBeNull();
  expect(tradeCheck(board(), { good: 'iron', side: 'buy', amount: '100' }).payload).toEqual({
    type: 'trade',
    cityKey: 30,
    good: 'iron',
    side: 'buy',
    amount: 100,
  });
  expect(tradeCheck(board(), { good: 'iron', side: 'buy', amount: '4134' }).payload).toBeNull();
  expect(tradeCheck(board(), { good: 'iron', side: 'buy', amount: '4501' }).reasons).toContain(
    '창고 남은 칸 4,500을 넘습니다.',
  );
  expect(tradeCheck(board(), { good: 'horses', side: 'sell', amount: '1501' }).payload).toBeNull();
  const huge = tradeCheck(board(), { good: 'horses', side: 'buy', amount: '2147483647' });
  expect(huge.total).toBe(2_147_483_647n * 5n);
  expect(huge.payload).toBeNull();
  expect(tradeCheck(board(), { good: 'iron', side: 'buy', amount: '0' }).payload).toBeNull();
});

it('읽기 전용 이유와 숫자 입력·손실률 표시는 서버 값을 바꾸지 않는다', () => {
  expect(readOnlyReason(board())).toBeNull();
  expect(readOnlyReason(board({ canManage: false, settling: true }))).toContain('월 정산');
  expect(readOnlyReason(board({ canManage: false, status: 'PAUSED' }))).toContain('진행 중인 월드가 아니라');
  expect(readOnlyReason(board({ canManage: false }))).toContain('국가 수뇌');
  expect(readCount('')).toBe(0);
  expect(readCount('2147483647')).toBe(2_147_483_647);
  expect(readCount('2147483648')).toBeNull();
  expect(readCount('1e3')).toBeNull();
  expect(lossPercent(200)).toBe('2%');
  expect(lossPercent(125)).toBe('1.25%');
});
