import type { ActionInput, FinishedTreaty, RecentAction, RequestId, RequestKind, RequestState } from './contract';

// 즉시 행동(제안·수락·거절)의 요청 추적. docs/plans/T2-08.md 화면 절, T2-07 "요청 식별과 재전송".
// 단추를 누르면 requestId를 만들어 보내기 전에 이 탭의 sessionStorage에 둔다. 결과가 확정될 때만 지운다.
// 응답을 잃으면 같은 requestId와 같은 내용으로 다시 보낸다. 서버는 같은 키를 입력 하나로 보고 그 결과를 돌려준다.

// sending: 보내는 중. pending: 엔진 처리를 기다림. checking: 새로 고침 뒤 결과를 묻는 중.
// unknown: 접수됐는지 모름(응답 유실, 서버 내부 오류). auth: 로그인이 풀려 결과를 받을 수 없음.
export type Phase = 'sending' | 'pending' | 'checking' | 'unknown' | 'auth';

export interface Tracked {
  requestId: RequestId;
  action: ActionInput;
  phase: Phase;
}

// applied·rejected는 엔진이 처리한 결과다. refused는 서버가 접수 단계에서 받지 않은 것이다.
export type FinishedResult = 'applied' | 'rejected' | 'refused';

export interface Finished {
  requestId: RequestId;
  action: ActionInput;
  result: FinishedResult;
  // applied일 때 엔진이 정한 결과. DECLINED는 받은 제안을 거절한 것이다.
  outcome: 'PROPOSED' | 'ACCEPTED' | 'DECLINED' | null;
  reason: string | null;
  // applied일 때 서버가 준 조약. 국가 ID만 있고 지금 장수의 국가가 당사국이 아니면 null이다.
  treaty: FinishedTreaty;
}

export interface RequestsState {
  tracked: Tracked[];
  finished: Finished[];
}

// v1은 제안에 expiresInMonths를 넣었다. 서버는 그 칸을 받지 않으므로 v1에 남은 요청을 같은 requestId로 다시 보내지 않게 판을 올렸다.
const STORAGE_PREFIX = 'opensamguk.treatyRequests.v2';

// 키에 계정과 월드를 넣는다 (예턴 초안 키와 같은 방식, turns/useTurnDraft.ts).
export const requestsStorageKey = (userId: string, worldId: string) => `${STORAGE_PREFIX}:${userId}:${worldId}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const FIRST_KINDS = new Set(['peace', 'nonAggression', 'note']);

function isAction(value: unknown): value is ActionInput {
  if (!isObject(value) || !isObject(value.input)) return false;
  const input = value.input;
  if (value.kind === 'treaty.propose')
    return (
      Object.keys(input).every((key) => key === 'toNationId' || key === 'clauses') &&
      Number.isInteger(input.toNationId) &&
      Array.isArray(input.clauses) &&
      (input.clauses as unknown[]).every(
        (clause) => isObject(clause) && typeof clause.kind === 'string' && FIRST_KINDS.has(clause.kind),
      )
    );
  if (value.kind === 'treaty.respond') return typeof input.treatyId === 'string' && typeof input.accept === 'boolean';
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

// 보내기 응답이나 treaty.request 응답을 반영한다. 엔진 거절도 오류가 아니라 rejected 값으로 온다.
export function applyOutcome(state: RequestsState, outcome: RequestState): RequestsState {
  if (outcome.status === 'pending') return setPhase(state, outcome.requestId, 'pending');
  if (outcome.status === 'applied')
    return finish(state, outcome.requestId, {
      result: 'applied',
      outcome: outcome.outcome,
      reason: null,
      treaty: outcome.treaty,
    });
  return finish(state, outcome.requestId, { result: 'rejected', outcome: null, reason: outcome.reason, treaty: null });
}

// 보내기가 tRPC 오류로 끝났을 때. code는 서버가 준 오류 코드이고 응답을 못 받았으면 undefined다.
// 응답 유실과 INTERNAL_SERVER_ERROR는 접수가 끝났을 수도 있어 unknown으로 두고 같은 requestId로 되찾는다.
// 그 밖의 코드(권한, 입력, 같은 대상 처리 중, 형식 1 월드 등)는 서버가 접수하지 않은 거부라 확정한다.
export function applySendError(
  state: RequestsState,
  requestId: RequestId,
  code: string | undefined,
  message: string | undefined,
): RequestsState {
  if (code === undefined || code === 'INTERNAL_SERVER_ERROR') return setPhase(state, requestId, 'unknown');
  if (code === 'UNAUTHORIZED') return setPhase(state, requestId, 'auth');
  return finish(state, requestId, {
    result: 'refused',
    outcome: null,
    reason: message ?? '요청을 받지 않았습니다.',
    treaty: null,
  });
}

// treaty.request가 실패했을 때. NOT_FOUND는 서버가 이 요청을 받은 적이 없다는 뜻이라 다시 보낼 수 있게 한다.
// 연결 실패와 내부 오류는 상태를 그대로 두고 다음에 다시 묻는다.
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
    t.action.kind === 'treaty.propose'
      ? target.toNationId !== undefined && t.action.input.toNationId === target.toNationId
      : target.treatyId !== undefined && t.action.input.treatyId === target.treatyId,
  );
}

export function actionLabel(action: ActionInput): string {
  if (action.kind === 'treaty.propose') return '제안';
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
      return '응답을 받지 못했습니다. 같은 요청으로 다시 보내면 처리 결과를 되찾습니다.';
    case 'auth':
      return '로그인이 풀렸습니다. 다시 로그인하면 이 요청의 결과를 이어서 확인합니다.';
  }
}

type Outcome = NonNullable<Finished['outcome']>;

// 엔진이 처리한 결과 문구. 같은 DECLINED라도 누가 거절했는지가 다르다.
// 제안한 쪽이 받는 DECLINED는 상대(예: NPC 즉시 판단)가 거절한 것이다. 응답한 쪽이 받는 DECLINED는 내가 거절한 것이다.
const APPLIED_TEXT: Record<RequestKind, Record<Outcome, string>> = {
  'treaty.propose': {
    PROPOSED: '제안을 보냈습니다. 상대가 답하면 목록에 나옵니다.',
    ACCEPTED: '상대가 제안을 받아 조약을 맺었습니다.',
    DECLINED: '상대가 제안을 거절했습니다.',
  },
  'treaty.respond': {
    PROPOSED: '처리되었습니다.',
    ACCEPTED: '조약을 맺었습니다.',
    DECLINED: '제안을 거절했습니다.',
  },
};

const RECENT_TEXT: Record<RequestKind, Record<Outcome, string>> = {
  'treaty.propose': { PROPOSED: '제안을 보냄', ACCEPTED: '상대가 수락해 조약을 맺음', DECLINED: '상대가 거절함' },
  'treaty.respond': { PROPOSED: '처리됨', ACCEPTED: '수락해 조약을 맺음', DECLINED: '받은 제안을 거절함' },
};

export function finishedText(item: Finished): string {
  if (item.result === 'refused')
    return `${actionLabel(item.action)} 요청을 서버가 받지 않았습니다. ${item.reason ?? ''}`.trim();
  if (item.result === 'rejected')
    return `${actionLabel(item.action)} 요청이 거절되었습니다. ${item.reason ?? ''}`.trim();
  return item.outcome === null ? '처리되었습니다.' : APPLIED_TEXT[item.action.kind][item.outcome];
}

// 목록의 최근 처리된 내 요청 한 줄. 엔진이 받아 처리한 결과와 받아들이지 않은 거절을 나눈다.
export function recentText(item: RecentAction): string {
  const kind = item.kind === 'treaty.propose' ? '제안' : '응답';
  if (item.result === 'REJECTED') return `${kind} · 받아들여지지 않음${item.reason ? ` (${item.reason})` : ''}`;
  return `${kind} · ${item.outcome === null ? '처리됨' : RECENT_TEXT[item.kind][item.outcome]}`;
}
