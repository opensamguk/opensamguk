import type { QueryClient, QueryFunction, QueryKey } from '@tanstack/react-query';
import { trpcClient, type Trpc } from '../trpc';
import type { CommandInfo } from './CommandPicker';
import { SLOT_COUNT, type Turn } from './draft';

// 예턴 편집기가 읽고 쓰는 칸 목록. 개인 30칸(turns.*)과 국가 직책 12칸(nationTurns.*, T2-06)이 같은 편집기를 쓴다.
// 편집기는 칸 수와 조회·저장 함수를 여기서만 받는다. 개인 칸은 personalSource가 지금 연결을 그대로 넘긴다.

export interface DisplaySlot {
  commandKey: string;
  args?: unknown;
  name: string;
}

export interface TurnList {
  revision: number;
  slots: DisplaySlot[];
}

export type SaveSlots = Array<{ commandKey: string; args: Record<string, unknown> } | null>;

export type SaveResult =
  | { ok: true; revision: number; slots: DisplaySlot[] }
  | { ok: false; reason: 'STALE'; revision: number; slots: DisplaySlot[] };

export type Check = { ok: true } | { ok: false; message: string };

export interface SourceQuery<T> {
  queryKey: QueryKey;
  queryFn: QueryFunction<unknown>;
  select: (data: unknown) => T;
}

export interface TurnSource {
  slotCount: number;
  // 저장하지 않은 편집을 두는 sessionStorage 키. 계정·월드(국가 칸은 본 직책까지)가 다르면 다른 키다.
  storageKey: string;
  gridLabel: string;
  list: SourceQuery<TurnList>;
  // 저장 뒤 받은 칸을 조회 캐시에 넣는다.
  writeList: (queryClient: QueryClient, list: TurnList) => void;
  save: (input: { revision: number; slots: SaveSlots }) => Promise<SaveResult>;
  commands: SourceQuery<CommandInfo[]>;
  precheck: (turn: Turn) => SourceQuery<Check>;
  // 서버 목록이 바뀌면 이 키 아래 사전 검사를 다시 받는다.
  precheckRoot: QueryKey;
  // 실행 시기를 셀 수 있는 칸인가. 국가 칸은 내 직책 칸만 내 턴에 실행된다.
  timed: boolean;
  // 편집할 수 없는 칸이면 서버가 준 이유. null이면 편집할 수 있다.
  readOnly: string | null;
  // 대상 장수 인자(generalId)를 이름으로 고를 장수 목록. 없으면 번호로 넣는다.
  generals?: Array<{ id: number; name: string }> | undefined;
  // 서버가 본 직책과 지금 직책이 다르다고 저장을 거부했을 때(국가 칸). 초안은 편집기가 버린다.
  onOfficeChanged?: (message: string) => void;
}

export interface SourceContext {
  trpc: Trpc;
  userId: string;
  worldId: string;
}

export type TurnSourceFactory = (context: SourceContext) => TurnSource;

const STORAGE_PREFIX = 'opensamguk.turnDraft.v1';

// 키에 계정 ID를 넣어 다른 계정으로 로그인하면 보이지 않게 한다.
export const draftStorageKey = (userId: string, worldId: string) => `${STORAGE_PREFIX}:${userId}:${worldId}`;

// 개인 30칸. T1-15 연결 그대로다.
export const personalSource: TurnSourceFactory = ({ trpc, userId, worldId }) => {
  const get = trpc.turns.get.queryOptions({ worldId });
  const commands = trpc.commands.list.queryOptions({ worldId });
  return {
    slotCount: SLOT_COUNT,
    storageKey: draftStorageKey(userId, worldId),
    gridLabel: `예턴 ${SLOT_COUNT}칸`,
    list: {
      queryKey: get.queryKey,
      queryFn: get.queryFn as QueryFunction<unknown>,
      select: (data) => data as TurnList,
    },
    writeList: (queryClient, list) => queryClient.setQueryData(get.queryKey, list),
    save: ({ revision, slots }) => trpcClient.turns.set.mutate({ worldId, revision, slots }),
    commands: {
      queryKey: commands.queryKey,
      queryFn: commands.queryFn as QueryFunction<unknown>,
      select: (data) => data as CommandInfo[],
    },
    precheck: (turn) => {
      const options = trpc.turns.precheck.queryOptions({ worldId, commandKey: turn.commandKey, args: turn.args });
      return {
        queryKey: options.queryKey,
        queryFn: options.queryFn as QueryFunction<unknown>,
        select: (data) => data as Check,
      };
    },
    precheckRoot: trpc.turns.precheck.pathKey(),
    timed: true,
    readOnly: null,
  };
};
