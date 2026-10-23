import { trpcClient } from '../trpc';

// 임시 계약. docs/plans/T2-11.md "API 계약" 절의 타입을 그대로 옮겼다.
// operation·inspection 라우터는 아직 AppRouter에 없다. Codex API가 main에 들어오면 AppRouter 타입으로 바꾼다.
// 그때 이 파일의 타입은 inferRouterOutputs로, operationApi·inspectionApi는 useTRPC()의 trpc.operation.*·trpc.inspection.*로 갈아 끼운다.
// 쿼리 키는 tRPC tanstack 키 모양으로 맞춰 두어서 바꾼 뒤에도 무효화 키가 같다.
//
// 서버 응답이 사용자 결정에 따라 달라질 수 있는 부분도 여기에만 모았다 (아래 "미결정" 표시).

export type GameDate = { year: number; month: number };
export type NationRef = { id: number; name: string; color: string };
export type Allowed = { ok: true } | { ok: false; code: string; reason: string };
// turns.get 칸과 같다. 빈 칸도 이름이 붙은 휴식이다.
export type SlotView = { commandKey: string; args: unknown; name: string };
export type Verdict = 'READY' | 'LATE' | 'WEAK' | 'MISSING';
export type Readiness = { crew: number; train: number; atmos: number };

export type OperationRow = {
  id: string;
  target: { cityKey: number; cityName: string; nation: NationRef | null };
  targetDate: GameDate;
  targetTick: number;
  targetAt: string | null;
  status: 'OPEN' | 'CLOSED';
  createdBy: { generalId: number; name: string };
  members: number;
  ready: number;
  joined: boolean;
};
export type TimelineCell = { slot: number; tick: number; at: string | null; date: GameDate; turn: SlotView };
export type MemberTimeline = {
  generalId: number;
  name: string;
  cityKey: number;
  cityName: string;
  isMe: boolean;
  verdict: Verdict;
  beyondWindow: boolean;
  sortie: TimelineCell | null;
  expected: Readiness;
  cells: TimelineCell[];
};
export type OperationDetail = Omit<OperationRow, 'joined'> & {
  min: Readiness;
  months: GameDate[];
  timeline: MemberTimeline[];
  canSuggest: Allowed;
  canClose: Allowed;
};
export type InspectionRow = {
  generalId: number;
  name: string;
  officerLevel: number;
  cityKey: number;
  cityName: string;
  isHuman: boolean;
  crew: number;
  train: number;
  atmos: number;
  turns: SlotView[];
  nextTurnAt: string | null;
  lastActiveAt: string | null;
  idle: boolean;
};
export type Suggestion = {
  revision: number;
  current: SlotView[];
  slots: SlotView[];
  changed: number[];
  warnings: { slot: number; reason: string }[];
};
export type CreateInput = {
  targetCityKey: number;
  targetYear: number;
  targetMonth: number;
  min: Readiness;
  memberIds: number[];
};

type Query<I, O> = { query: (input: I) => Promise<O> };
type Mutation<I, O> = { mutate: (input: I) => Promise<O> };
type World = { worldId: string };

interface OperationClient {
  list: Query<World, { canCreate: Allowed; items: OperationRow[] }>;
  get: Query<World & { id: string }, OperationDetail>;
  suggest: Query<World & { id: string }, Suggestion>;
  create: Mutation<World & CreateInput, { id: string }>;
  close: Mutation<World & { id: string }, OperationRow>;
}
interface InspectionClient {
  members: Query<World, { items: InspectionRow[] }>;
}

// trpcClient는 경로를 런타임에 만드는 프록시라 타입에 없는 프로시저도 /trpc/operation.* 로 간다. 캐스트는 이 한 곳에만 둔다.
const client = trpcClient as unknown as { operation: OperationClient; inspection: InspectionClient };
export const operationApi = client.operation;
export const inspectionApi = client.inspection;

export const operationQueryKey = (procedure: keyof OperationClient, input: Record<string, unknown>) =>
  [['operation', procedure], { input, type: 'query' }] as const;
export const OPERATION_PATH_KEY = [['operation']] as const;
export const inspectionQueryKey = (input: World) => [['inspection', 'members'], { input, type: 'query' }] as const;

// 직책자(작전 만들기·감찰)는 officerLevel 5 이상 (T2-11 공개 범위, T2-05 표). 메뉴를 보일지에만 쓰고 권한은 서버가 정한다.
export const OFFICER_MIN_LEVEL = 5;
// 출병 명령 키. 제안 칸에서 출병을 찾을 때 쓰지 않고(서버가 sortie를 준다) 타임라인 칸 강조에만 쓴다.
export const SORTIE_COMMAND_KEY = 'attack';

// 미결정 U62-4a: 목표 연월의 경계. 화면은 서버의 verdict·sortie만 보여 주고 tick으로 직접 판정하지 않는다.
// 미결정 U62-4b: 지난 연월을 목표로 만들 수 있는지. 화면은 막지 않고 서버의 BAD_REQUEST 문장을 보인다.
// 미결정 U62-4c: 목표가 30칸 밖일 때. 서버의 beyondWindow를 그대로 보인다.
// 미결정 U62-1: 일반 참여 장수가 다른 참여자의 예턴을 어디까지 보는지. 서버가 cells를 비우거나 줄여 보내도 그리도록 칸이 없는 달은 비워 둔다.
// 미결정 U62-5·U63(T2-13 직접 휴식 구분): suggest 칸은 메인 편집기의 toTurn·toSaveSlots를 그대로 거친다. 작전판이 따로 변환하지 않는다.
