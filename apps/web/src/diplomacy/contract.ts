import { trpcClient } from '../trpc';

// 임시 계약. docs/plans/T2-07.md "API 계약"·"즉시 행동 처리" 절의 응답 모양을 그대로 옮겼다.
// treaty 라우터는 아직 AppRouter에 없다. Codex API가 main에 들어오면 AppRouter 타입으로 바꾼다.
// 그때 이 파일의 타입은 inferRouterOutputs로, treatyApi는 useTRPC()의 trpc.treaty.*로 갈아 끼운다.
// 쿼리 키는 tRPC tanstack 키 모양으로 맞춰 두어서 바꾼 뒤에도 무효화 키가 같다.
//
// 서버 응답이 사용자 결정에 따라 달라질 수 있는 부분도 여기에만 모았다 (아래 "미결정" 표시).

export type GameDate = { year: number; month: number };
export type NationRef = { id: number; name: string; color: string };

// 화면은 code로만 분기하고 reason은 DisabledReason으로 보여 준다. 권한 검사가 먼저라 NO_PERMISSION이면 다른 이유는 오지 않는다.
export type DenyCode = 'NO_PERMISSION' | 'NOT_PARTY' | 'IN_PROGRESS' | 'WRONG_STATUS' | 'EXPIRED' | 'INSUFFICIENT_GOLD';
export type Allowed = { ok: true } | { ok: false; code: DenyCode; reason: string };

export type Clause =
  | { kind: 'peace' }
  | { kind: 'nonAggression'; months: number }
  | { kind: 'passage'; cityKeys: number[] }
  | { kind: 'tribute'; payerNationId: number; gold: number; rice: number; months: number }
  | { kind: 'trade'; months: number }
  | { kind: 'cityTransfer'; cityKey: number; giverNationId: number }
  | { kind: 'note'; text: string };
export type ClauseKind = Clause['kind'];
export type ClauseView = Clause & { enforced: boolean; cityNames?: string[] };

export type TreatyStatus = 'PROPOSED' | 'ACTIVE' | 'ENDED' | 'BROKEN' | 'REJECTED' | 'EXPIRED';
export type TrustRow = { nation: NationRef; brokenTreaties: number; lastBrokenAt: GameDate | null };
export type TreatyRow = {
  id: string;
  from: NationRef;
  to: NationRef;
  incoming: boolean;
  clauses: ClauseView[];
  status: TreatyStatus;
  proposedSeq: number;
  proposedAt: GameDate;
  respondBy: GameDate | null;
  startAt: GameDate | null;
  endAt: GameDate | null;
  monthsLeft: number | null;
  brokenBy: NationRef | null;
  cost: { mine: number; theirs: number };
  counterpartTrust: TrustRow;
  canAccept: Allowed | null;
  canReject: Allowed | null;
  canBreak: Allowed | null;
};

export type RequestId = string;
export type ActionKind = 'propose' | 'respond' | 'break';
export type InputOutcome =
  { status: 'applied'; requestId: RequestId; treaty: TreatyRow | null } | { status: 'pending'; requestId: RequestId };
export type RequestState = InputOutcome | { status: 'rejected'; requestId: RequestId; code: string; reason: string };
export type PendingAction = {
  requestId: RequestId;
  kind: ActionKind;
  treatyId: string | null;
  toNation: NationRef | null;
  accept: boolean | null;
  requestedBy: { generalId: number; name: string };
};
export type RecentAction = {
  requestId: RequestId;
  kind: ActionKind;
  treatyId: string | null;
  result: 'APPLIED' | 'REJECTED';
  reason: string | null;
};
export type Relation = 'WAR' | 'DECLARED' | 'NON_AGGRESSION' | 'NONE';
export type TreatyTarget = { nation: NationRef; relation: Relation; relationEndAt: GameDate | null; trust: TrustRow };
export type TradeTarget = {
  cityKey: number;
  cityName: string;
  nation: NationRef;
  treatyId: string;
  tradeEndsAt: GameDate;
};

export type TreatyList = {
  canPropose: Allowed;
  targets: TreatyTarget[];
  items: TreatyRow[];
  pending: PendingAction[];
  myRecent: RecentAction[];
};
export type Quote = { cost: { mine: number; theirs: number }; problems: { index: number; reason: string }[] };
export type TradeTargets = { fromCityKey: number | null; items: TradeTarget[]; blocked: string | null };

export type ProposeInput = { toNationId: number; clauses: Clause[]; expiresInMonths: number };
export type RespondInput = { treatyId: string; accept: boolean };
export type BreakInput = { treatyId: string };
export type ActionInput =
  | { kind: 'propose'; input: ProposeInput }
  | { kind: 'respond'; input: RespondInput }
  | { kind: 'break'; input: BreakInput };

type WithWorld<T> = T & { worldId: string };
type Query<I, O> = { query: (input: I) => Promise<O> };
type Mutation<I, O> = { mutate: (input: I) => Promise<O> };

interface TreatyClient {
  list: Query<{ worldId: string }, TreatyList>;
  trust: Query<{ worldId: string }, { items: TrustRow[] }>;
  quote: Query<WithWorld<{ toNationId: number; clauses: Clause[] }>, Quote>;
  request: Query<{ worldId: string; requestId: RequestId }, RequestState>;
  tradeTargets: Query<{ worldId: string }, TradeTargets>;
  propose: Mutation<WithWorld<ProposeInput & { requestId: RequestId }>, InputOutcome>;
  respond: Mutation<WithWorld<RespondInput & { requestId: RequestId }>, InputOutcome>;
  break: Mutation<WithWorld<BreakInput & { requestId: RequestId }>, InputOutcome>;
}

// trpcClient는 경로를 런타임에 만드는 프록시라 타입에 없는 프로시저도 /trpc/treaty.* 로 간다. 캐스트는 이 한 곳에만 둔다.
export const treatyApi = (trpcClient as unknown as { treaty: TreatyClient }).treaty;

export const treatyQueryKey = (procedure: keyof TreatyClient, input: Record<string, unknown>) =>
  [['treaty', procedure], { input, type: 'query' }] as const;
// 조약 쿼리 전체. 결과가 확정되면 목록·신의·교역 대상을 한 번에 다시 받는다.
export const TREATY_PATH_KEY = [['treaty']] as const;

// 보내기: 행동 종류에 맞는 프로시저를 같은 requestId로 부른다.
export function sendAction(worldId: string, requestId: RequestId, action: ActionInput): Promise<InputOutcome> {
  if (action.kind === 'propose') return treatyApi.propose.mutate({ worldId, requestId, ...action.input });
  if (action.kind === 'respond') return treatyApi.respond.mutate({ worldId, requestId, ...action.input });
  return treatyApi.break.mutate({ worldId, requestId, ...action.input });
}

// 계약 상수. 서버가 같은 값으로 검사한다 (T2-07 조항 결정).
export const NON_AGGRESSION_MONTHS = { min: 1, max: 120 };
export const NOTE_MAX_LENGTH = 300;
// 제안 기한 6개월 (T2-07 조항 결정). 입력 칸을 두지 않고 이 값으로 보낸다.
export const PROPOSAL_EXPIRES_MONTHS = 6;
// 장수 명령 교역 (T2-07 범위). 인자 모양은 계획에 없어 출병처럼 정수 cityKey 하나로 가정했다.
// 편집기는 commands.list의 argsSchema로 칸을 만들므로 cityKey면 이 후보 목록을 쓴다. 계약이 확정되면 맞춘다.
export const TRADE_COMMAND_KEY = 'trade';

// 미결정 U62-6: 형식 1 월드에서 treaty.* 쓰기를 막을지. 막으면 서버가 이유 문장과 함께 거부한다.
// 화면은 코드를 추측하지 않고 오류 문장을 그대로 보여 준다. 읽기는 빈 목록을 준다는 초안이라 빈 상태로 그린다.
// 미결정 U62-3: 상대 쪽 사정으로 수락이 거절될 때 이유 코드(초안 COUNTERPART_UNAVAILABLE)와 문장.
// 화면은 rejected의 reason 문장만 보여 주고 code로 분기하지 않는다.
// 미결정 U62-2a: 비용 공식. 화면은 quote·cost 숫자만 보여 주고 직접 계산하지 않는다.
// 미결정 U62-5: 재생 형식 2 소유. 화면 응답 모양에는 영향이 없다.
