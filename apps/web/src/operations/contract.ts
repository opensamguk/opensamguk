import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

// 작전판(T2-12)이 쓰는 응답 모양. AppRouter 타입에서만 꺼낸다 (T2-11 operation·inspection 라우터).
// 호출과 캐시 키는 useTRPC()의 queryOptions·mutationOptions·queryKey·pathKey로만 만든다.
// 판정(verdict·beyondWindow), 제안(changed·noop·warnings), 활동(idle)과 거부 문장은 서버 값을 그대로 보인다.

type Outputs = inferRouterOutputs<AppRouter>;
type Inputs = inferRouterInputs<AppRouter>;

export type OperationList = Outputs['operation']['list'];
export type OperationRow = OperationList['items'][number];
export type Allowed = OperationList['canCreate'];
export type OperationDetail = Outputs['operation']['get'];
export type MemberTimeline = OperationDetail['timeline'][number];
export type TimelineCell = MemberTimeline['cells'][number];
export type GameDate = OperationDetail['targetDate'];
export type Verdict = MemberTimeline['verdict'];
export type Readiness = OperationDetail['min'];
export type Suggestion = Outputs['operation']['suggest'];
export type SuggestionWarning = Suggestion['warnings'][number];
export type SuggestionNoop = NonNullable<Suggestion['noop']>;
// 서버 displaySlots 칸. explicit이 false면 비워 둔 칸이고 true인 휴식은 직접 넣은 휴식이다.
export type SlotView = Suggestion['current'][number];
export type InspectionRow = Outputs['inspection']['members']['items'][number];
export type CreateInput = Omit<Inputs['operation']['create'], 'worldId'>;

// 직책자(작전 만들기·감찰)는 officerLevel 5 이상 (T2-11 공개 범위, T2-05 표). 메뉴를 보일지에만 쓰고 권한은 서버가 정한다.
export const OFFICER_MIN_LEVEL = 5;
// 출병 명령 키. 제안 칸에서 출병을 찾을 때 쓰지 않고(서버가 sortie를 준다) 타임라인 칸 강조에만 쓴다.
export const SORTIE_COMMAND_KEY = 'attack';

// 사용자 결정(2026-10-23)은 서버가 판정한다. 화면은 다시 계산하지 않는다.
// U62-1 일반 참여자도 다른 참여자의 30칸 명령과 인자를 본다. U62-4a 목표 연월 첫 tick과 같은 tick의 출병은 LATE다.
// U62-4b 지난 연월은 서버가 BAD_REQUEST 문장으로 거부한다. U62-4c 30칸 밖 목표도 만들 수 있고 beyondWindow로 온다.
