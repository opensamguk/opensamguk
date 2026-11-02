import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

// 물류 API 계약의 화면 쪽 타입과 표시 도움 함수 (T4-93, AC-P2-30).
// 값과 한도는 모두 logistics.get이 준 것만 쓴다. 아래 이유 목록은 단추를 막고 까닭을 보이는 안내일 뿐이며
// 최종 판정은 접수와 엔진이 한다. 게임 규칙(경로·손실 계산·생산)은 여기서 다시 계산하지 않는다.
export type LogisticsBoard = inferRouterOutputs<AppRouter>['logistics']['get'];
export type OwnLogisticsBoard = Extract<LogisticsBoard, { own: true }>;
export type LogisticsPayload = inferRouterInputs<AppRouter>['logistics']['submit']['payload'];
export type LogisticsRequestResult = inferRouterOutputs<AppRouter>['logistics']['request'];
export type LogisticsGood = 'iron' | 'wood' | 'horses';
export type LogisticsMovement = OwnLogisticsBoard['movements'][number];

export const LOGISTICS_GOODS: ReadonlyArray<readonly [LogisticsGood, string]> = [
  ['iron', '철'],
  ['wood', '목재'],
  ['horses', '말'],
];
export const GOOD_LABEL: Record<LogisticsGood, string> = { iron: '철', wood: '목재', horses: '말' };
const GOOD_TOPIC: Record<LogisticsGood, string> = { iron: '철은', wood: '목재는', horses: '말은' };
export const MOVEMENT_REASON: Record<LogisticsMovement['reason'], string> = {
  PRODUCE: '월 생산',
  CONSUME: '소비',
  DEPART: '출발',
  ARRIVE: '도착',
  RETURN: '반환',
  CAPTURE: '노획',
  LOSS_TRANSIT: '운송 손실',
  LOSS_OVERFLOW: '창고 초과 손실',
  TRADE: '교역',
  UPGRADE: '증축',
};

export const LOGISTICS_MAX = 2_147_483_647;
export const formatCount = (value: number | bigint) => value.toLocaleString('ko-KR');

// 입력 칸의 문자열을 0 이상 32비트 정수로 읽는다. 빈 칸은 0이다. 정수가 아니면 null이다.
export function readCount(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return 0;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= LOGISTICS_MAX ? value : null;
}

// 서버가 준 손실률(만분율)을 백분율 문구로만 바꾼다. 재화별 버림은 엔진이 한다.
export function lossPercent(lossBp: number): string {
  return `${(lossBp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export type DispatchDraft = { to: string } & Record<LogisticsGood, string>;
export function dispatchCheck(board: OwnLogisticsBoard, draft: DispatchDraft) {
  const reasons: string[] = [];
  const destination = board.destinations.find((row) => String(row.cityKey) === draft.to) ?? null;
  if (!destination) reasons.push('도착지를 고르세요.');
  const goods = { iron: readCount(draft.iron), wood: readCount(draft.wood), horses: readCount(draft.horses) };
  if (LOGISTICS_GOODS.some(([good]) => goods[good] === null)) reasons.push('수량은 0 이상의 정수로 넣으세요.');
  const total = LOGISTICS_GOODS.reduce((sum, [good]) => sum + (goods[good] ?? 0), 0);
  if (total < 1) reasons.push('보낼 재화를 하나 이상 넣으세요.');
  for (const [good] of LOGISTICS_GOODS)
    if ((goods[good] ?? 0) > board.resources[good])
      reasons.push(`${GOOD_TOPIC[good]} ${formatCount(board.resources[good])}까지 보낼 수 있습니다.`);
  if (total > board.costs.transport.maxPerOrder)
    reasons.push(`한 번에 ${formatCount(board.costs.transport.maxPerOrder)}까지 보낼 수 있습니다.`);
  if (board.convoys.length >= board.costs.transport.maxActivePerNation)
    reasons.push('국가의 수송대 수가 한도에 찼습니다. 도착하거나 취소된 뒤에 보낼 수 있습니다.');
  // 도착지 남은 칸은 조회 시점 값이라 막지 않고 손실 가능성만 알린다.
  const overflowRisk = destination !== null && total > destination.freeCapacity;
  const payload: LogisticsPayload | null =
    reasons.length === 0 && destination
      ? {
          type: 'dispatch',
          fromCityKey: board.cityKey,
          toCityKey: destination.cityKey,
          goods: { iron: goods.iron!, wood: goods.wood!, horses: goods.horses! },
        }
      : null;
  return { reasons, destination, total, overflowRisk, payload };
}

export function upgradeCheck(board: OwnLogisticsBoard) {
  const reasons: string[] = [];
  const { gold, wood } = board.costs.upgrade;
  const level = board.resources.level,
    maxLevel = board.costs.capacity.maxLevel;
  if (level >= maxLevel) reasons.push(`창고가 이미 최대 ${formatCount(maxLevel)}단계입니다.`);
  if (board.gold < gold) reasons.push(`도시 금이 ${formatCount(gold - board.gold)} 부족합니다.`);
  if (board.resources.wood < wood) reasons.push(`목재가 ${formatCount(wood - board.resources.wood)} 부족합니다.`);
  // 다음 단계 용량은 서버가 준 base·perLevel을 그대로 더한 표시값이다.
  const nextCapacity =
    level < maxLevel ? board.costs.capacity.base + board.costs.capacity.perLevel * (level + 1) : null;
  const payload: LogisticsPayload | null = reasons.length === 0 ? { type: 'upgrade', cityKey: board.cityKey } : null;
  return { reasons, nextCapacity, payload };
}

export type TradeDraft = { good: LogisticsGood; side: 'buy' | 'sell'; amount: string };
export function tradeCheck(board: OwnLogisticsBoard, draft: TradeDraft) {
  const reasons: string[] = [];
  const price = board.costs.trade[draft.good][draft.side];
  const amount = readCount(draft.amount);
  const total = amount === null ? null : BigInt(amount) * BigInt(price);
  if (amount === null || amount < 1) reasons.push('수량은 1 이상의 정수로 넣으세요.');
  else if (draft.side === 'buy') {
    if (total! > BigInt(board.gold)) reasons.push(`도시 금이 부족합니다. 필요한 금은 ${formatCount(total!)}입니다.`);
    if (board.used + amount > board.capacity)
      reasons.push(`창고 남은 칸 ${formatCount(Math.max(0, board.capacity - board.used))}을 넘습니다.`);
  } else if (amount > board.resources[draft.good])
    reasons.push(`${GOOD_TOPIC[draft.good]} ${formatCount(board.resources[draft.good])}까지 팔 수 있습니다.`);
  const payload: LogisticsPayload | null =
    reasons.length === 0 && amount
      ? { type: 'trade', cityKey: board.cityKey, good: draft.good, side: draft.side, amount }
      : null;
  return { reasons, price, total, payload };
}

// 관리할 수 없을 때의 쉬운 안내. 서버가 준 상태 값만 본다.
export function readOnlyReason(board: OwnLogisticsBoard): string | null {
  if (board.canManage) return null;
  if (board.status !== 'RUNNING') return '진행 중인 월드가 아니라 물류는 볼 수만 있습니다.';
  if (board.settling)
    return '월 정산을 처리하는 중이라 지금은 볼 수만 있습니다. 정산이 끝나면 다시 지시할 수 있습니다.';
  return '물류 지시는 국가 수뇌 직책만 할 수 있습니다. 보급이 끊긴 거점이거나 이용이 제한된 동안에는 볼 수만 있습니다.';
}
