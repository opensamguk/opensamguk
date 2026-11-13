import type { LineageInput, SuccessionPreview } from './lineageModel';

// 접수를 확인하지 못한 가문 요청 하나를 이 탭에 둔다 (T4-95, AC-P2-32). 황실(governanceRequestState)과 같은 규칙에
// 보낸 장수 id(generalId)를 더한다. 키는 계정·월드 기준이라 계승으로 장수가 바뀌어도 같은 번호로 결과를 찾는다.
// 같은 요청 재접수는 처음 보낸 장수 id·번호·내용을 그대로 보낸다. 자동으로 다시 보내거나 새 번호를 만들지 않는다.
export type LineagePending = { requestId: string; generalId: number; payload: LineageInput };
export type LineageRequestMode = 'submit' | 'check' | 'resubmit';
// 확인 대화상자를 연 계정·세션·장수. 셋 중 하나라도 지금과 다르면 그 대화상자로 보내지 않는다.
export type LineageOwner = { userId: string; session: number; actorId: number };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INT_MAX = 2_147_483_647;
const int = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const id = (value: unknown): value is number => int(value, 1, INT_MAX);
const count = (value: unknown): value is number => int(value, 0, INT_MAX);
const ids = (value: unknown): value is number[] => Array.isArray(value) && value.every(id);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const OFFICES = ['chancellor', 'grandMarshal', 'minister'] as const;

export const lineageStorageKey = (userId: string, worldId: string) => `lineage.pending:${userId}:${worldId}`;

function readEquipmentSlots(value: unknown): NonNullable<SuccessionPreview['equipment']>['from'] | undefined {
  if (value === null) return null;
  const raw = record(value),
    slots = ['horse', 'weapon', 'book'] as const;
  if (
    !raw ||
    Object.keys(raw).length === 0 ||
    Object.keys(raw).some((key) => key !== 'tool' && !slots.includes(key as (typeof slots)[number]))
  )
    return undefined;
  const result: NonNullable<NonNullable<SuccessionPreview['equipment']>['from']> = {};
  for (const slot of slots) {
    if (!Object.hasOwn(raw, slot)) continue;
    const key = raw[slot];
    if (typeof key !== 'string' || !new RegExp(`^${slot}_(0[1-6]|15)$`).test(key)) return undefined;
    result[slot] = key;
  }
  if (Object.hasOwn(raw, 'tool')) {
    const tool = record(raw.tool);
    if (!tool || !exactKeys(tool, ['key', 'charges'])) return undefined;
    if (tool.key === 'tool_01' && int(tool.charges, 1, 3)) result.tool = { key: tool.key, charges: tool.charges };
    else if (tool.key === 'tool_02' && tool.charges === 1) result.tool = { key: tool.key, charges: tool.charges };
    else return undefined;
  }
  return result;
}

// 서버는 미리보기를 JSON 문자열로 비교한다. 저장값을 서버 스키마의 칸 순서로 다시 만들어 그대로 보낸다.
function readPreview(value: unknown): SuccessionPreview | null {
  const raw = record(value);
  const keys = ['heirId', 'officerLevel', 'gold', 'rice', 'crew', 'unitIds', 'keptRetinue', 'releasedRetinue'];
  if (
    !raw ||
    !exactKeys(raw, [
      ...keys,
      'cancelledOrders',
      'cancelledOffers',
      'governance',
      ...(Object.hasOwn(raw, 'equipment') ? ['equipment'] : []),
    ])
  )
    return null;
  let equipment: SuccessionPreview['equipment'];
  if (Object.hasOwn(raw, 'equipment')) {
    const source = record(raw.equipment);
    if (!source || !exactKeys(source, ['from', 'heir', 'inherited'])) return null;
    const from = readEquipmentSlots(source.from),
      heir = readEquipmentSlots(source.heir),
      inherited = readEquipmentSlots(source.inherited);
    if (from === undefined || heir === undefined || inherited === undefined) return null;
    equipment = { from, heir, inherited };
  }
  const governance = record(raw.governance);
  if (!governance || !exactKeys(governance, ['throne', 'courtOffice', 'vassalIds'])) return null;
  if (!Array.isArray(raw.cancelledOffers)) return null;
  const offers = raw.cancelledOffers.map(record);
  if (
    !id(raw.heirId) ||
    !int(raw.officerLevel, 0, 12) ||
    ![raw.gold, raw.rice, raw.crew].every(count) ||
    ![raw.unitIds, raw.keptRetinue, raw.releasedRetinue, raw.cancelledOrders, governance.vassalIds].every(ids) ||
    !offers.every(
      (row) =>
        row !== null &&
        exactKeys(row, ['kind', 'id']) &&
        (row.kind === 'RETINUE' || row.kind === 'ASSIGNMENT') &&
        typeof row.id === 'string' &&
        row.id.length > 0 &&
        row.id.length <= 200,
    ) ||
    typeof governance.throne !== 'boolean' ||
    !(governance.courtOffice === null || OFFICES.includes(governance.courtOffice as (typeof OFFICES)[number]))
  )
    return null;
  return {
    ...(equipment ? { equipment } : {}),
    heirId: raw.heirId,
    officerLevel: raw.officerLevel,
    gold: raw.gold as number,
    rice: raw.rice as number,
    crew: raw.crew as number,
    unitIds: [...(raw.unitIds as number[])],
    keptRetinue: [...(raw.keptRetinue as number[])],
    releasedRetinue: [...(raw.releasedRetinue as number[])],
    cancelledOrders: [...(raw.cancelledOrders as number[])],
    cancelledOffers: offers.map((row) => ({ kind: row!.kind as 'RETINUE' | 'ASSIGNMENT', id: row!.id as string })),
    governance: {
      throne: governance.throne,
      courtOffice: governance.courtOffice as SuccessionPreview['governance']['courtOffice'],
      vassalIds: [...(governance.vassalIds as number[])],
    },
  };
}

// 탭에 저장한 값을 서버 입력 모양 다섯 가지로만 읽어 새 객체로 만든다. 여분 칸·소수·범위 밖 값은 버린다.
export function readLineagePayload(value: unknown): LineageInput | null {
  const raw = record(value);
  if (!raw) return null;
  const only = (...keys: string[]) => exactKeys(raw, ['type', ...keys]);
  const type = raw.type;
  if (type === 'marriage.propose')
    return only('targetGeneralId') && id(raw.targetGeneralId) ? { type, targetGeneralId: raw.targetGeneralId } : null;
  if (type === 'marriage.respond')
    return only('offerId', 'accept') && id(raw.offerId) && typeof raw.accept === 'boolean'
      ? { type, offerId: raw.offerId, accept: raw.accept }
      : null;
  if (type === 'heir.designate') {
    const heir = raw.heirGeneralId;
    return only('heirGeneralId') && (heir === null || id(heir)) ? { type, heirGeneralId: heir } : null;
  }
  if (type === 'succession.confirm') {
    const heir = raw.heirGeneralId;
    const expected = only('heirGeneralId', 'expected') && id(heir) ? readPreview(raw.expected) : null;
    return expected && expected.heirId === heir ? { type, heirGeneralId: expected.heirId, expected } : null;
  }
  if (type === 'ruler.claim') return only('nationId') && id(raw.nationId) ? { type, nationId: raw.nationId } : null;
  return null;
}

export function readLineagePending(storage: Pick<Storage, 'getItem'>, key: string): LineagePending | null {
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
  const value = record(raw);
  if (!value || !exactKeys(value, ['requestId', 'generalId', 'payload'])) return null;
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId) || !id(value.generalId)) return null;
  const payload = readLineagePayload(value.payload);
  return payload ? { requestId: value.requestId, generalId: value.generalId, payload } : null;
}

export function sameLineageRequest(a: LineagePending | null, b: LineagePending | null): boolean {
  if (!a || !b || a.requestId !== b.requestId || a.generalId !== b.generalId) return false;
  const left = readLineagePayload(a.payload),
    right = readLineagePayload(b.payload);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function writeLineagePending(storage: Pick<Storage, 'setItem'>, key: string, request: LineagePending) {
  storage.setItem(
    key,
    JSON.stringify({ requestId: request.requestId, generalId: request.generalId, payload: request.payload }),
  );
}

// 새 제출만 새 번호를 만든다. 상태 확인과 같은 요청 재접수는 저장된 번호·장수·내용을 그대로 쓴다.
export function lineageModeAllowed(
  mode: LineageRequestMode,
  context: {
    request: LineagePending;
    pending: LineagePending | null;
    saved: LineagePending | null;
    canSubmit: boolean;
    stale: boolean;
  },
): boolean {
  const { request, pending, saved, canSubmit, stale } = context;
  if (mode === 'submit') return pending === null && saved === null && canSubmit && !stale;
  if (!sameLineageRequest(pending, request)) return false;
  return mode === 'check' || (sameLineageRequest(saved, request) && canSubmit);
}

// 대화상자를 연 계정·보기 세션·장수가 지금 보기와 모두 같아야 보낸다. 계승으로 같은 계정의 장수만 바뀐 경우도 막는다.
export function ownerCurrent(
  owner: LineageOwner,
  current: { userId: string; session: number; actorId: number | null } | null,
): boolean {
  return (
    current !== null &&
    owner.userId === current.userId &&
    owner.session === current.session &&
    owner.actorId === current.actorId
  );
}

// 저장된 값이 이 요청과 같을 때만 지운다. 다른 탭이 만든 요청이면 남기고 false를 돌려준다.
export function forgetLineagePending(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  key: string,
  request: LineagePending,
): boolean {
  const saved = readLineagePending(storage, key);
  if (!saved) {
    storage.removeItem(key);
    return true;
  }
  if (!sameLineageRequest(saved, request)) return false;
  storage.removeItem(key);
  return true;
}
