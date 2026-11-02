import { LOGISTICS_MAX, type LogisticsPayload } from '../queries/logistics';

// 접수를 확인하지 못한 물류 요청 하나를 이 탭에 둔다. 계정·월드마다 다른 키라 다른 계정에 넘어가지 않는다.
// 월드당 하나만 두어 결과를 보기 전에는 다른 거점에서도 새 요청을 만들지 않는다. 자동으로 다시 보내지 않는다.
export type LogisticsPending = { requestId: string; payload: LogisticsPayload };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOODS = ['iron', 'wood', 'horses'] as const;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= LOGISTICS_MAX;
const positive = (value: unknown): value is number => count(value) && value > 0;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const logisticsStorageKey = (userId: string, worldId: string) => `logistics.pending:${userId}:${worldId}`;

// 서버 입력 모양 네 가지만 받아 새 객체로 만든다. 여분 칸·소수·음수·모양이 다른 값은 버린다.
export function readLogisticsPayload(value: unknown): LogisticsPayload | null {
  const raw = record(value);
  if (!raw) return null;
  if (raw.type === 'dispatch') {
    const goods = record(raw.goods);
    if (!exactKeys(raw, ['type', 'fromCityKey', 'toCityKey', 'goods']) || !goods || !exactKeys(goods, GOODS))
      return null;
    if (!positive(raw.fromCityKey) || !positive(raw.toCityKey) || raw.fromCityKey === raw.toCityKey) return null;
    if (!count(goods.iron) || !count(goods.wood) || !count(goods.horses)) return null;
    if (goods.iron + goods.wood + goods.horses < 1) return null;
    return {
      type: 'dispatch',
      fromCityKey: raw.fromCityKey,
      toCityKey: raw.toCityKey,
      goods: { iron: goods.iron, wood: goods.wood, horses: goods.horses },
    };
  }
  if (raw.type === 'cancel')
    return exactKeys(raw, ['type', 'convoyId']) && positive(raw.convoyId)
      ? { type: 'cancel', convoyId: raw.convoyId }
      : null;
  if (raw.type === 'upgrade')
    return exactKeys(raw, ['type', 'cityKey']) && positive(raw.cityKey)
      ? { type: 'upgrade', cityKey: raw.cityKey }
      : null;
  if (raw.type === 'trade') {
    if (!exactKeys(raw, ['type', 'cityKey', 'good', 'side', 'amount'])) return null;
    if (!positive(raw.cityKey) || !positive(raw.amount)) return null;
    if (raw.good !== 'iron' && raw.good !== 'wood' && raw.good !== 'horses') return null;
    if (raw.side !== 'buy' && raw.side !== 'sell') return null;
    return { type: 'trade', cityKey: raw.cityKey, good: raw.good, side: raw.side, amount: raw.amount };
  }
  return null;
}

export function readLogisticsPending(storage: Pick<Storage, 'getItem'>, key: string): LogisticsPending | null {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
  const value = record(raw);
  if (!value || !exactKeys(value, ['requestId', 'payload'])) return null;
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId)) return null;
  const payload = readLogisticsPayload(value.payload);
  return payload ? { requestId: value.requestId, payload } : null;
}

// 칸 순서와 상관없이 같은 내용인지 본다. 둘 다 위 검사를 거친 모양으로 바꿔 비교한다.
export function samePayload(a: unknown, b: unknown): boolean {
  const left = readLogisticsPayload(a),
    right = readLogisticsPayload(b);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function writeLogisticsPending(storage: Pick<Storage, 'setItem'>, key: string, request: LogisticsPending) {
  storage.setItem(key, JSON.stringify({ requestId: request.requestId, payload: request.payload }));
}

// 요청 단추 세 가지. 새 제출만 새 번호를 만든다. 상태 확인과 같은 요청 재접수는 저장된 번호·내용을 그대로 쓴다.
export type LogisticsRequestMode = 'submit' | 'check' | 'resubmit';

export function requestModeAllowed(
  mode: LogisticsRequestMode,
  context: {
    request: LogisticsPending;
    pending: LogisticsPending | null;
    saved: LogisticsPending | null;
    canManage: boolean;
    stale: boolean;
  },
): boolean {
  const { request, pending, saved, canManage, stale } = context;
  if (mode === 'submit') return pending === null && saved === null && canManage && !stale;
  const same = (value: LogisticsPending | null) =>
    value !== null && value.requestId === request.requestId && samePayload(value.payload, request.payload);
  if (!same(pending)) return false;
  // 같은 요청 재접수는 탭 기록이 그대로 있고 지금 관리 권한이 있을 때만 한다. 권한이 없으면 상태 확인만 한다.
  return mode === 'check' || (same(saved) && canManage);
}

// 다시 조회하다 실패했을 때 보이는 값을 지워야 하는가. 계정·권한·월드 상태가 바뀐 응답이면 지운다.
// 응답을 못 받은 연결 실패나 서버 일시 오류는 같은 계정의 화면과 입력을 남기고 오래된 값으로 표시한다.
const LOST_ACCESS = ['UNAUTHORIZED', 'FORBIDDEN', 'CONFLICT', 'PRECONDITION_FAILED', 'NOT_FOUND'];
export function refreshFailureClearsView(code: string | undefined, identityChanged: boolean): boolean {
  return identityChanged || (code !== undefined && LOST_ACCESS.includes(code));
}

// 저장된 값이 이 요청과 같을 때만 지운다. 다른 요청(다른 탭이 만든 것)이면 남기고 false를 돌려준다.
export function forgetLogisticsPending(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
  request: LogisticsPending,
): boolean {
  const saved = readLogisticsPending(storage, key);
  if (!saved) {
    storage.removeItem(key);
    return true;
  }
  if (saved.requestId !== request.requestId || !samePayload(saved.payload, request.payload)) return false;
  storage.removeItem(key);
  return true;
}
