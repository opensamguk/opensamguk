import type { GovernanceInput, GovernanceOffice } from './governanceModel';

// 접수를 확인하지 못한 황실 요청 하나를 이 탭에 둔다 (T4-94, AC-P2-31). 물류(logisticsRequestState)와 같은 규칙이다.
// 계정·월드마다 다른 키라 다른 계정에 넘어가지 않는다. 결과를 보기 전에는 새 황실 요청을 만들지 않고 자동으로 다시 보내지 않는다.
export type GovernancePending = { requestId: string; payload: GovernanceInput };
export type GovernanceRequestMode = 'submit' | 'check' | 'resubmit';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INT_MAX = 2_147_483_647;
const OFFICES: readonly GovernanceOffice[] = ['chancellor', 'grandMarshal', 'minister'];
const int = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const id = (value: unknown): value is number => int(value, 1, INT_MAX);
const bp = (value: unknown): value is number => int(value, 0, 10_000);
const office = (value: unknown): value is GovernanceOffice => OFFICES.includes(value as GovernanceOffice);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export const governanceStorageKey = (userId: string, worldId: string) => `governance.pending:${userId}:${worldId}`;

// 탭에 저장한 값을 서버 입력 모양 열두 가지로만 읽어 새 객체로 만든다. 여분 칸·소수·범위 밖 값은 버린다.
// 모양만 본다. 권한·한도 판정은 서버가 한다.
export function readGovernancePayload(value: unknown): GovernanceInput | null {
  const raw = record(value);
  if (!raw) return null;
  const only = (...keys: string[]) => exactKeys(raw, ['type', ...keys]);
  const type = raw.type;
  if (type === 'throne.ascend' || type === 'throne.abdicate' || type === 'court.resign')
    return only() ? { type } : null;
  if (type === 'vassal.offer') {
    if (!only('authority', 'targetNationId', 'direction', 'goldBp', 'riceBp')) return null;
    if (raw.authority !== 'OWN' && raw.authority !== 'EMPIRE') return null;
    if (raw.direction !== 'DEMAND' && raw.direction !== 'REQUEST') return null;
    if (!id(raw.targetNationId) || !bp(raw.goldBp) || !bp(raw.riceBp)) return null;
    return {
      type,
      authority: raw.authority,
      targetNationId: raw.targetNationId,
      direction: raw.direction,
      goldBp: raw.goldBp,
      riceBp: raw.riceBp,
    };
  }
  if (type === 'vassal.respond' || type === 'court.respond')
    return only('offerId', 'accept') && id(raw.offerId) && typeof raw.accept === 'boolean'
      ? { type, offerId: raw.offerId, accept: raw.accept }
      : null;
  if (type === 'vassal.release' || type === 'vassal.renounce')
    return only('vassalId') && id(raw.vassalId) ? { type, vassalId: raw.vassalId } : null;
  if (type === 'court.offer')
    return only('office', 'generalId') && office(raw.office) && id(raw.generalId)
      ? { type, office: raw.office, generalId: raw.generalId }
      : null;
  if (type === 'court.dismiss') return only('office') && office(raw.office) ? { type, office: raw.office } : null;
  if (type === 'court.remit')
    return only('vassalId', 'months') && id(raw.vassalId) && int(raw.months, 1, 12)
      ? { type, vassalId: raw.vassalId, months: raw.months }
      : null;
  if (type === 'court.censure') return only('nationId') && id(raw.nationId) ? { type, nationId: raw.nationId } : null;
  return null;
}

export function readGovernancePending(storage: Pick<Storage, 'getItem'>, key: string): GovernancePending | null {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
  const value = record(raw);
  if (!value || !exactKeys(value, ['requestId', 'payload'])) return null;
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId)) return null;
  const payload = readGovernancePayload(value.payload);
  return payload ? { requestId: value.requestId, payload } : null;
}

export function sameGovernancePayload(a: unknown, b: unknown): boolean {
  const left = readGovernancePayload(a),
    right = readGovernancePayload(b);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function writeGovernancePending(storage: Pick<Storage, 'setItem'>, key: string, request: GovernancePending) {
  storage.setItem(key, JSON.stringify({ requestId: request.requestId, payload: request.payload }));
}

// 새 제출만 새 번호를 만든다. 상태 확인과 같은 요청 재접수는 저장된 번호·내용을 그대로 쓴다.
export function governanceModeAllowed(
  mode: GovernanceRequestMode,
  context: {
    request: GovernancePending;
    pending: GovernancePending | null;
    saved: GovernancePending | null;
    canSubmit: boolean;
    stale: boolean;
  },
): boolean {
  const { request, pending, saved, canSubmit, stale } = context;
  if (mode === 'submit') return pending === null && saved === null && canSubmit && !stale;
  const same = (value: GovernancePending | null) =>
    value !== null && value.requestId === request.requestId && sameGovernancePayload(value.payload, request.payload);
  if (!same(pending)) return false;
  return mode === 'check' || (same(saved) && canSubmit);
}

// 저장된 값이 이 요청과 같을 때만 지운다. 다른 탭이 만든 요청이면 남기고 false를 돌려준다.
export function forgetGovernancePending(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
  request: GovernancePending,
): boolean {
  const saved = readGovernancePending(storage, key);
  if (!saved) {
    storage.removeItem(key);
    return true;
  }
  if (saved.requestId !== request.requestId || !sameGovernancePayload(saved.payload, request.payload)) return false;
  storage.removeItem(key);
  return true;
}
