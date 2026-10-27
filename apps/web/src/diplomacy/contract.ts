import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc, trpcClient } from '../trpc';

// 외교실이 쓰는 타입. 모두 AppRouter treaty의 실제 출력에서 꺼낸다 (T2-07 첫 세 조항, AC-M2-06).
// 권한과 조약 상태는 서버의 실제 출력에 맞춘다.

type Outputs = inferRouterOutputs<AppRouter>['treaty'];

export type TreatyListPage = Outputs['list'];
export type TreatyItem = TreatyListPage['items'][number];
export type TreatyStatus = TreatyItem['status'];
export type NationRef = NonNullable<TreatyItem['from']>;
export type Allowed = NonNullable<TreatyItem['canAccept']>;
export type TreatyTarget = TreatyListPage['targets'][number];
export type Relation = TreatyTarget['relation'];
export type PendingAction = TreatyListPage['pending'][number];
export type RecentAction = TreatyListPage['myRecent'][number];
// 저장된 조항. 첫 세 조항(종전·불가침·기록만 남길 약속)뿐이다.
export type Clause = TreatyItem['clauses'][number];
export type ClauseKind = Clause['kind'];
export type Quote = Outputs['quote'];
export type RequestState = Outputs['request'];
export type RequestKind = RequestState['kind'];
// 끝난 요청의 조약. 국가 ID만 있고 지금 장수의 국가가 당사국이 아니면 null이다.
export type FinishedTreaty = Extract<RequestState, { status: 'applied' }>['treaty'];
export type RequestId = RequestState['requestId'];

// 서버 입력의 toNationId·clauses는 unknown으로 받고 서버가 정규화한다. 화면은 첫 세 조항만 만들어 보낸다.
export type ProposeInput = { toNationId: number; clauses: Clause[] };
export type RespondInput = { treatyId: string; accept: boolean };
export type ActionInput =
  | { kind: Extract<RequestKind, 'treaty.propose'>; input: ProposeInput }
  | { kind: Extract<RequestKind, 'treaty.respond'>; input: RespondInput }
  | { kind: Extract<RequestKind, 'treaty.break'>; input: { treatyId: string } };

// 조약 쿼리 전체(목록·견적·요청). 결과가 확정되면 이 키로 한 번에 다시 받는다.
export const TREATY_PATH_KEY = trpc.treaty.pathKey();

// 목록 한 쪽. 서버 입력이 strict라 infiniteQueryOptions가 붙이는 direction을 거부하므로 직접 부른다 (messages/queries.ts와 같은 이유).
export function fetchTreatyPage(worldId: string, cursor: string | null, signal: AbortSignal) {
  return trpcClient.treaty.list.query(cursor === null ? { worldId } : { worldId, cursor }, { signal });
}

// 보내기. 행동 종류에 맞는 절차를 같은 requestId로 부른다. 엔진 거절도 HTTP 200의 rejected 값으로 온다.
export function sendAction(worldId: string, requestId: RequestId, action: ActionInput): Promise<RequestState> {
  if (action.kind === 'treaty.propose')
    return trpcClient.treaty.propose.mutate({ worldId, requestId, ...action.input });
  if (action.kind === 'treaty.break') return trpcClient.treaty.break.mutate({ worldId, requestId, ...action.input });
  return trpcClient.treaty.respond.mutate({ worldId, requestId, ...action.input });
}

// 결과 되찾기. 본인이 보낸 requestId만 서버가 찾아 준다.
export function fetchRequest(worldId: string, requestId: RequestId): Promise<RequestState> {
  return trpcClient.treaty.request.query({ worldId, requestId });
}

// 화면 검사용 상수. 최종 판단은 서버 정규화와 엔진이 한다 (packages/rules diplomacy/treaty.ts).
export const NON_AGGRESSION_MONTHS = { min: 1, max: 120 };
export const NOTE_MAX_LENGTH = 300;
// 받은 쪽이 답할 기한. 엔진이 정하는 값이고 제안 입력에는 없다.
export const PROPOSAL_RESPONSE_MONTHS = 6;
// 장수 명령 교역 (T2-08). 교역 조항과 교역 대상 조회가 서버에 없어 후보를 만들지 않는다 (tradeTargets.ts).
export const TRADE_COMMAND_KEY = 'trade';
