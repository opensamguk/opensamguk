import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTRPC } from '../trpc';
import { useWorldEnded } from '../game/queries';
import { errorCode, retryUnlessClientError, serverMessage } from './apiError';
import { applyOp, applyOps, SLOT_COUNT, toSaveSlots, toTurn, type EditOp, type Turn } from './draft';

// 화면에 모아 둔 편집. 저장은 [저장] 한 번에 turns.set으로 30칸을 보낸다 (계획: 편집은 모았다가 한 번 저장).
// baseRevision은 편집을 시작한 서버 목록의 revision이다. 서버가 그 사이 바뀌었으면 STALE이 돌아온다.
export interface Draft {
  baseRevision: number;
  ops: EditOp[];
  turns: Turn[];
}

// STALE 뒤 사용자가 고를 때까지 보관하는 내 편집.
export interface Pending {
  ops: EditOp[];
}

interface Stored {
  draft: Draft | null;
  pending: Pending | null;
}

export type SaveNotice =
  | { kind: 'saved' }
  | { kind: 'stale' }
  | { kind: 'auth' }
  | { kind: 'error'; message: string }
  | { kind: 'reapplied' }
  | null;

const STORAGE_PREFIX = 'opensamguk.turnDraft.v1';

// 저장하지 않은 편집은 이 탭의 sessionStorage에 둔다. 새로고침이나 다시 로그인한 뒤에도 이어서 저장할 수 있다.
// 키에 계정 ID를 넣어 다른 계정으로 로그인하면 보이지 않게 한다.
export const draftStorageKey = (userId: string, worldId: string) => `${STORAGE_PREFIX}:${userId}:${worldId}`;

// explicit이 없는 칸은 T2-14 전에 보관한 초안이다. 그때 휴식은 빈칸으로 저장됐으므로 toTurn과 같은 규칙으로 읽는다.
function isTurn(value: unknown): value is Turn {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.commandKey === 'string' &&
    typeof turn.args === 'object' &&
    turn.args !== null &&
    !Array.isArray(turn.args) &&
    (turn.explicit === undefined || typeof turn.explicit === 'boolean')
  );
}

function normalizeOp(op: EditOp): EditOp {
  return 'put' in op ? { put: { ...op.put, turn: toTurn(op.put.turn) } } : op;
}

function isOp(value: unknown): value is EditOp {
  if (typeof value !== 'object' || value === null) return false;
  const op = value as Record<string, unknown>;
  if ('shift' in op) return Number.isInteger(op.shift);
  if ('repeat' in op) {
    const r = op.repeat as Record<string, unknown> | null;
    return !!r && Number.isInteger(r.from) && Number.isInteger(r.to) && Number.isInteger(r.times);
  }
  if ('put' in op) {
    const p = op.put as Record<string, unknown> | null;
    return !!p && Array.isArray(p.indices) && p.indices.every(Number.isInteger) && isTurn(p.turn);
  }
  return false;
}

export function readStored(storage: Storage | undefined, key: string): Stored {
  const empty: Stored = { draft: null, pending: null };
  try {
    const raw = storage?.getItem(key);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const draft = parsed.draft as Record<string, unknown> | null;
    const pending = parsed.pending as Record<string, unknown> | null;
    const okDraft =
      !!draft &&
      Number.isInteger(draft.baseRevision) &&
      Array.isArray(draft.ops) &&
      draft.ops.every(isOp) &&
      Array.isArray(draft.turns) &&
      draft.turns.length === SLOT_COUNT &&
      draft.turns.every(isTurn);
    const okPending = !!pending && Array.isArray(pending.ops) && pending.ops.every(isOp);
    const goodDraft = okDraft ? (draft as unknown as Draft) : null;
    const goodPending = okPending ? (pending as unknown as Pending) : null;
    return {
      draft: goodDraft && {
        baseRevision: goodDraft.baseRevision,
        ops: goodDraft.ops.map(normalizeOp),
        turns: goodDraft.turns.map(toTurn),
      },
      pending: goodPending && { ops: goodPending.ops.map(normalizeOp) },
    };
  } catch {
    return empty;
  }
}

function writeStored(storage: Storage | undefined, key: string, value: Stored) {
  try {
    if (!value.draft && !value.pending) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(value));
  } catch {
    // 저장 공간이 막혀 있어도 화면 편집은 계속한다.
  }
}

const sessionStore = () => (typeof window === 'undefined' ? undefined : window.sessionStorage);

// 고른 칸도 같은 탭에 둔다. 외교실이나 작전판에 갔다 돌아와도 초안과 함께 선택이 남는다 (T2-08·T2-12 초안 보존).
export const selectionStorageKey = (draftKey: string) => `${draftKey}:selection`;

export function readSelection(storage: Storage | undefined, key: string): Set<number> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key) ?? '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < SLOT_COUNT));
  } catch {
    return new Set();
  }
}

export function writeSelection(storage: Storage | undefined, key: string, selected: ReadonlySet<number>) {
  try {
    if (selected.size === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify([...selected].sort((a, b) => a - b)));
  } catch {
    // 저장 공간이 막혀 있어도 화면 선택은 계속한다.
  }
}

export function useStoredSelection(draftKey: string) {
  const key = selectionStorageKey(draftKey);
  const [selected, setSelected] = useState<Set<number>>(() => readSelection(sessionStore(), key));
  useEffect(() => writeSelection(sessionStore(), key, selected), [key, selected]);
  return [selected, setSelected] as const;
}

export function useTurnDraft(worldId: string, storageKey: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const turnsKey = trpc.turns.get.queryKey({ worldId });
  const ended = useWorldEnded(worldId);
  const server = useQuery({
    ...trpc.turns.get.queryOptions({ worldId }),
    // 엔진이 턴을 실행하면 목록이 당겨진다. 편집 중이 아니면 바로 보이도록 자주 묻는다. 끝난 판은 더 당겨지지 않는다.
    refetchInterval: ended ? false : 10_000,
    retry: retryUnlessClientError,
  });

  const [stored, setStored] = useState<Stored>(() => readStored(sessionStore(), storageKey));
  const [notice, setNotice] = useState<SaveNotice>(null);
  const { draft, pending } = stored;

  useEffect(() => writeStored(sessionStore(), storageKey, stored), [storageKey, stored]);

  const serverTurns = useMemo(() => server.data?.slots.map((slot) => toTurn(slot)) ?? null, [server.data]);
  const turns = pending ? serverTurns : (draft?.turns ?? serverTurns);

  const edit = useCallback(
    (op: EditOp) => {
      const data = server.data;
      if (!data || !serverTurns) return;
      setNotice(null);
      setStored((prev) => {
        if (prev.pending) return prev;
        const base = prev.draft ?? { baseRevision: data.revision, ops: [], turns: serverTurns };
        return { draft: { ...base, ops: [...base.ops, op], turns: applyOp(base.turns, op) }, pending: null };
      });
    },
    [server.data, serverTurns],
  );

  const discard = useCallback(() => {
    setNotice(null);
    setStored({ draft: null, pending: null });
  }, []);

  // 충돌 뒤 [내 편집 다시 적용]: 최신 목록에 같은 편집을 같은 순서로 다시 적용한다. 저장은 사용자가 확인한 뒤 한다.
  const reapply = useCallback(() => {
    const data = server.data;
    if (!data || !serverTurns) return;
    setStored((prev) => {
      if (!prev.pending) return prev;
      const ops = prev.pending.ops;
      return { draft: { baseRevision: data.revision, ops, turns: applyOps(serverTurns, ops) }, pending: null };
    });
    setNotice({ kind: 'reapplied' });
  }, [server.data, serverTurns]);

  const save = useMutation({
    ...trpc.turns.set.mutationOptions(),
    onSuccess: (result) => {
      queryClient.setQueryData(turnsKey, { revision: result.revision, slots: result.slots });
      if (result.ok) {
        // 저장 중에는 편집을 막으므로 지금 초안이 곧 저장한 내용이다.
        setStored({ draft: null, pending: null });
        setNotice({ kind: 'saved' });
      } else {
        setStored((prev) => ({ draft: null, pending: { ops: prev.draft?.ops ?? [] } }));
        setNotice({ kind: 'stale' });
      }
      void queryClient.invalidateQueries({ queryKey: trpc.home.get.queryKey({ worldId }) });
    },
    onError: (error) => {
      const code = errorCode(error);
      if (code === 'UNAUTHORIZED') setNotice({ kind: 'auth' });
      else
        setNotice({
          kind: 'error',
          message: serverMessage(error) ?? '저장하지 못했습니다. 연결을 확인하고 다시 저장하세요.',
        });
    },
  });

  const submit = useCallback(() => {
    if (!draft || save.isPending) return;
    setNotice(null);
    save.mutate({ worldId, revision: draft.baseRevision, slots: toSaveSlots(draft.turns) });
  }, [draft, save, worldId]);

  const authLost = notice?.kind === 'auth' || (server.isError && errorCode(server.error) === 'UNAUTHORIZED');

  return {
    server,
    turns,
    serverTurns,
    draft,
    pending,
    notice,
    authLost,
    saving: save.isPending,
    // 다른 곳(다른 탭, 엔진의 턴 실행)에서 목록이 바뀌었는데 아직 저장하지 않은 편집이 있다.
    behind: !!draft && !!server.data && server.data.revision !== draft.baseRevision,
    edit,
    discard,
    reapply,
    submit,
  };
}

// 편집기 바깥 부품(작전 맞추기, T2-12)이 같은 초안에 편집을 넣을 때 받는 상태.
export type TurnDraftState = ReturnType<typeof useTurnDraft>;
