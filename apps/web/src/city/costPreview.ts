// 모병·투자 재화 비용 미리보기 (T4-93, AC-P2-30). 모집 비용 계산은 엔진과 같은 rules의 recruitGoods를 그대로 쓴다.
// 병종 이름·병과 번호·100명당 비용·투자 비용은 모두 logistics.get이 준 값이다. 화면은 병과 번호의 뜻을 따로 정하지 않는다.
import { recruitGoods } from '@opensamguk/rules/logistics-costs';
import { LOGISTICS_GOODS, type LogisticsGood, type OwnLogisticsBoard } from '../queries/logistics';

export const RECRUIT_PREVIEW_MAX = 1_000_000;
type Goods = Record<LogisticsGood, number>;
type CostBoard = Pick<OwnLogisticsBoard, 'recruitUnits' | 'costs' | 'resources'>;

// 모집 인원 입력. 1..1,000,000 정수만 받는다. 빈 칸은 아직 입력 전이다.
export function readRecruitAmount(raw: string): number | null | 'empty' {
  const text = raw.trim();
  if (text === '') return 'empty';
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= RECRUIT_PREVIEW_MAX ? value : null;
}

// 지금 재고보다 많은 재화와 모자란 양. 예약은 미래에 처리되므로 막지 않고 알리기만 한다.
export function shortGoods(stock: Goods, cost: Goods): Array<{ good: LogisticsGood; missing: number }> {
  return LOGISTICS_GOODS.filter(([good]) => cost[good] > stock[good]).map(([good]) => ({
    good,
    missing: cost[good] - stock[good],
  }));
}

export type RecruitPreview =
  | { kind: 'idle' }
  | { kind: 'invalid' }
  | { kind: 'unknown' }
  | { kind: 'ready'; per100: Goods; cost: Goods; short: ReturnType<typeof shortGoods> };

export function recruitPreview(board: CostBoard, unitId: string, amountText: string): RecruitPreview {
  const unit = board.recruitUnits.find((row) => String(row.id) === unitId);
  const amount = readRecruitAmount(amountText);
  if (!unit || amount === 'empty') return { kind: 'idle' };
  if (amount === null) return { kind: 'invalid' };
  const per100 = board.costs.recruitPer100[String(unit.armType)];
  if (!per100) return { kind: 'unknown' };
  const cost = recruitGoods({ recruitPer100: board.costs.recruitPer100 }, unit.armType, amount);
  return { kind: 'ready', per100, cost, short: shortGoods(board.resources, cost) };
}
