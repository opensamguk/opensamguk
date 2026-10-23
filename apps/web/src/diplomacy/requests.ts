import type { ActionInput, RequestId, RequestState, TreatyRow } from './contract';

// 즉시 행동(제안·수락·거절·파기)의 요청 추적. docs/plans/T2-08.md 화면 절, T2-07 "요청 식별과 재전송".
// 단추를 누르면 requestId를 만들어 보내기 전에 이 탭의 sessionStorage에 둔다. 결과가 applied나 rejected로 확정될 때만 지운다.
// 응답을 잃으면 같은 requestId와 같은 내용으로 다시 보낸다. 서버는 같은 키를 입력 하나로 본다.

// sending: 보내는 중. pending: 엔진 처리를 기다림. checking: 새로 고침 뒤 결과를 묻는 중.
// unknown: 응답을 받지 못함(서버에 닿았는지 모름). auth: 로그인이 풀려 결과를 받을 수 없음.
export type Phase = 'sending' | 'pending' | 'checking' | 'unknown' | 'auth';

export interface Tracked {
  requestId: RequestId;
  action: ActionInput;
  phase: Phase;
}

export interface Finished {
  requestId: RequestId;
  action: ActionInput;
  result: 'applied' | 'rejected';
  reason: string | null;
  // applied일 때 서버가 준 조약. 지금 장수의 국가가 당사국이 아니면 null이고 화면은 결과 문구만 보인다.
  treaty: TreatyRow | null;
}

export interface RequestsState {
  tracked: Tracked[];
  finished: Finished[];
}

const STORAGE_PREFIX = 'opensamguk.treatyRequests.v1';

// 키에 계정과 월드를 넣는다 (예턴 초안 키와 같은 방식, turns/useTurnDraft.ts).
export const requestsStorageKey = (userId: string, worldId: string) => `${STORAGE_PREFIX}:${userId}:${worldId}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isAction(value: unknown): value is ActionInput {
  if (!isObject(value) || !isObject(value.input)) return false;
  const input = value.input;
  if (value.kind === 'propose')
    return (
      Number.isInteger(input.toNationId) && Array.isArray(input.clauses) && Number.isInteger(input.expiresInMonths)
    );
  if (value.kind === 'respond') return typeof input.treatyId === 'string' && typeof input.accept === 'boolean';
  if (value.kind === 'break') return typeof input.treatyId === 'string';
  return false;
}

// 저장한 요청을 되살린다. 결과를 모르므로 모두 checking으로 시작해 treaty.request로 묻는다.
export function readTracked(storage: Storage | undefined, key: string): Tracked[] {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is { requestId: string; action: ActionInput } =>
          isObject(item) && typeof item.requestId === 'string' && item.requestId !== '' && isAction(item.action),
      )
      .map((item) => ({ requestId: item.requestId, action: item.action, phase: 'checking' as const }));
  } catch {
    return [];
  }
}

export function writeTracked(storage: Storage | undefined, key: string, tracked: readonly Tracked[]) {
  try {
    if (tracked.length === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(tracked.map(({ requestId, action }) => ({ requestId, action }))));
  } catch {
    // 저장 공간이 막혀도 이 화면에서는 계속 추적한다.
  }
}

const setPhase = (state: RequestsState, requestId: RequestId, phase: Phase): RequestsState => ({
  ...state,
  tracked: state.tracked.map((t) => (t.requestId === requestId ? { ...t, phase } : t)),
});

function finish(
  state: RequestsState,
  requestId: RequestId,
  result: Omit<Finished, 'requestId' | 'action'>,
): RequestsState {
  const item = state.tracked.find((t) => t.requestId === requestId);
  if (!item) return state;
  return {
    tracked: state.tracked.filter((t) => t.requestId !== requestId),
    finished: [
      { requestId, action: item.action, ...result },
      ...state.finished.filter((f) => f.requestId !== requestId),
    ],
  };
}

export const startRequest = (state: RequestsState, requestId: RequestId, action: ActionInput): RequestsState => ({
  ...state,
  tracked: [...state.tracked, { requestId, action, phase: 'sending' }],
});

export const resendRequest = (state: RequestsState, requestId: RequestId) => setPhase(state, requestId, 'sending');

// 보내기 응답이나 treaty.request 응답을 반영한다. applied·rejected일 때만 결과가 확정된다.
export function applyOutcome(state: RequestsState, outcome: RequestState): RequestsState {
  if (outcome.status === 'pending') return setPhase(state, outcome.requestId, 'pending');
  if (outcome.status === 'applied')
    return finish(state, outcome.requestId, { result: 'applied', reason: null, treaty: outcome.treaty });
  return finish(state, outcome.requestId, { result: 'rejected', reason: outcome.reason, treaty: null });
}

// 보내기가 실패했을 때. code는 서버가 준 tRPC 오류 코드이고 응답을 못 받았으면 undefined다.
// 엔진이 대기 시간 안에 거절하면 서버가 이유 코드와 문장으로 오류를 준다. 그것은 확정된 거절이다.
export function applySendError(
  state: RequestsState,
  requestId: RequestId,
  code: string | undefined,
  message: string | undefined,
): RequestsState {
  if (code === undefined) return setPhase(state, requestId, 'unknown');
  if (code === 'UNAUTHORIZED') return setPhase(state, requestId, 'auth');
  return finish(state, requestId, {
    result: 'rejected',
    reason: message ?? '요청이 받아들여지지 않았습니다.',
    treaty: null,
  });
}

// treaty.request가 실패했을 때. NOT_FOUND는 서버가 이 요청을 받은 적이 없다는 뜻이라 다시 보낼 수 있게 한다.
// 연결 실패는 상태를 그대로 두고 다음에 다시 묻는다.
export function applyCheckError(state: RequestsState, requestId: RequestId, code: string | undefined): RequestsState {
  if (code === 'NOT_FOUND') return setPhase(state, requestId, 'unknown');
  if (code === 'UNAUTHORIZED') return setPhase(state, requestId, 'auth');
  return state;
}

export const dismissFinished = (state: RequestsState, requestId: RequestId): RequestsState => ({
  ...state,
  finished: state.finished.filter((f) => f.requestId !== requestId),
});

export const shouldPoll = (phase: Phase) => phase === 'pending' || phase === 'checking';

// 이 조약(또는 이 상대에게 보내는 제안)에 결과를 기다리는 내 요청이 있는지.
export function trackedFor(tracked: readonly Tracked[], target: { treatyId?: string; toNationId?: number }) {
  return tracked.find((t) =>
    t.action.kind === 'propose'
      ? target.toNationId !== undefined && t.action.input.toNationId === target.toNationId
      : target.treatyId !== undefined && t.action.input.treatyId === target.treatyId,
  );
}

export function actionLabel(action: ActionInput): string {
  if (action.kind === 'propose') return '제안';
  if (action.kind === 'break') return '파기';
  return action.input.accept ? '수락' : '거절';
}

export function phaseText(phase: Phase): string {
  switch (phase) {
    case 'sending':
      return '보내는 중';
    case 'pending':
    case 'checking':
      return '처리 중. 엔진이 처리하면 결과가 나옵니다.';
    case 'unknown':
      return '응답을 받지 못했습니다. 같은 요청으로 다시 보낼 수 있습니다.';
    case 'auth':
      return '로그인이 풀렸습니다. 다시 로그인하면 이 요청의 결과를 이어서 확인합니다.';
  }
}

export function finishedText(item: Finished): string {
  if (item.result === 'rejected')
    return `${actionLabel(item.action)} 요청이 거절되었습니다. ${item.reason ?? ''}`.trim();
  if (item.action.kind === 'propose') return '제안을 보냈습니다. 상대가 답하면 목록에 나옵니다.';
  if (item.action.kind === 'break') return '조약을 파기했습니다. 신의 기록에 남았습니다.';
  return item.action.input.accept ? '조약을 맺었습니다.' : '제안을 거절했습니다.';
}
