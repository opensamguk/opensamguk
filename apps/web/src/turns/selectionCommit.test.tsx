// @vitest-environment jsdom
import { StrictMode, useLayoutEffect, type PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DisplaySlot, TurnSource } from './source';
import {
  readStored,
  useTurnDraft,
  readSelection,
  selectionStorageKey,
  useStoredSelection,
  writeSelection,
} from './useTurnDraft';
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});
it.each([false, true])(
  'T3-10 AC-M1-19 DOM에 확정한 선택은 다음 문서 이동 전 같은 commit에 저장한다 (StrictMode=%s)',
  (strict) => {
    const key = selectionStorageKey('commit-selection');
    writeSelection(window.sessionStorage, key, new Set([2]));
    const observed: number[][] = [];
    const { result } = renderHook(
      () => {
        const state = useStoredSelection('commit-selection');
        useLayoutEffect(() => {
          observed.push([...readSelection(window.sessionStorage, key)]);
        }, [state[0]]);
        return state;
      },
      strict ? { wrapper: StrictMode } : undefined,
    );
    act(() => result.current[1](new Set([2, 4])));
    expect([...result.current[0]]).toEqual([2, 4]);
    expect(observed.at(-1)).toEqual([2, 4]);
  },
);

// React의 commit 저장 경계만 보는 단위 시험이다. 실제 API·DB 인수 근거는 별도 Chromium/PG 검사다.
vi.mock('../trpc', () => ({ useTRPC: () => ({ home: { get: { queryKey: () => ['home'] } } }) }));
vi.mock('../game/queries', () => ({ useWorldEnded: () => false }));
const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
});
function draftProbe(slotCount: number, key = 'draft-commit', strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  const listKey = ['draft', key];
  const list = {
    revision: 3,
    slots: Array.from({ length: slotCount }, () => ({ commandKey: 'rest', args: {}, name: '휴식', explicit: false })),
  };
  client.setQueryData(listKey, list);
  const save = vi.fn<TurnSource['save']>().mockResolvedValue({ ok: true, revision: 4, slots: list.slots });
  const source: TurnSource<DisplaySlot> = {
    slotCount,
    storageKey: key,
    gridLabel: '예턴',
    list: { queryKey: listKey, queryFn: async () => list, select: (value) => value as typeof list },
    writeList: (cache, value) => cache.setQueryData(listKey, value),
    save,
    commands: { queryKey: ['commands'], queryFn: async () => [], select: () => [] },
    precheck: () => ({ queryKey: ['precheck'], queryFn: async () => ({ ok: true }), select: () => ({ ok: true }) }),
    precheckRoot: ['precheck'],
    timed: false,
    readOnly: null,
  };
  const observed: ReturnType<typeof readStored>[] = [];
  function Wrapper({ children }: PropsWithChildren) {
    const content = <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return strict ? <StrictMode>{content}</StrictMode> : content;
  }
  const hook = renderHook(
    () => {
      const state = useTurnDraft('world', source);
      useLayoutEffect(() => {
        observed.push(readStored(window.sessionStorage, key, slotCount));
      }, [state.draft, state.pending]);
      return state;
    },
    { wrapper: Wrapper },
  );
  return { ...hook, observed, save, client, source };
}
it.each([12, 30])('T3-10 AC-M1-19 %i칸 초안도 DOM commit 안에서 다음 문서 이동 전에 보관한다', (count) => {
  const probe = draftProbe(count);
  act(() =>
    probe.result.current.edit({
      put: { indices: [count - 1], turn: { commandKey: 'farm', args: {}, explicit: true } },
    }),
  );
  expect(probe.result.current.draft?.turns[count - 1]?.commandKey).toBe('farm');
  expect(probe.observed.at(-1)?.draft?.turns[count - 1]?.commandKey).toBe('farm');
});

it('충돌 pending·다시 적용·저장 성공의 제거도 같은 commit에 보관한다', async () => {
  const probe = draftProbe(30);
  probe.save.mockResolvedValueOnce({
    ok: false,
    reason: 'STALE',
    revision: 4,
    slots: Array.from({ length: 30 }, () => ({ commandKey: 'rest', args: {}, name: '휴식' })),
  });
  act(() =>
    probe.result.current.edit({ put: { indices: [4], turn: { commandKey: 'farm', args: {}, explicit: true } } }),
  );
  act(() => probe.result.current.submit());
  await waitFor(() => expect(probe.result.current.pending).not.toBeNull());
  expect(probe.observed.at(-1)?.pending?.ops).toEqual([
    { put: { indices: [4], turn: { commandKey: 'farm', args: {}, explicit: true } } },
  ]);
  act(() => probe.result.current.reapply());
  expect(probe.observed.at(-1)?.pending).toBeNull();
  expect(probe.observed.at(-1)?.draft?.turns[4]?.commandKey).toBe('farm');
  act(() => probe.result.current.submit());
  await waitFor(() => expect(probe.result.current.notice?.kind).toBe('saved'));
  expect(probe.observed.at(-1)).toEqual({ draft: null, pending: null });
  expect(window.sessionStorage.getItem('draft-commit')).toBeNull();
});
it('저장 실패 후 초안과 계정·월드·국가 직책 키 분리를 유지한다', async () => {
  const probe = draftProbe(12, 'user-a:world-a:office-a');
  probe.save.mockRejectedValueOnce(new Error('offline'));
  act(() =>
    probe.result.current.edit({ put: { indices: [11], turn: { commandKey: 'farm', args: {}, explicit: true } } }),
  );
  act(() => probe.result.current.submit());
  await waitFor(() => expect(probe.result.current.notice?.kind).toBe('error'));
  expect(readStored(window.sessionStorage, 'user-a:world-a:office-a', 12).draft?.turns[11]?.commandKey).toBe('farm');
  probe.unmount();
  for (const key of ['user-b:world-a:office-a', 'user-a:world-b:office-a', 'user-a:world-a:office-b']) {
    const other = draftProbe(12, key);
    expect(other.result.current.draft).toBeNull();
    other.unmount();
  }
  const restored = draftProbe(12, 'user-a:world-a:office-a');
  expect(restored.result.current.draft?.turns[11]?.commandKey).toBe('farm');
});
it('탭 저장 공간의 쓰기가 막혀도 선택과 화면 편집은 이어 간다', () => {
  const probe = draftProbe(30);
  const selection = renderHook(() => useStoredSelection('blocked-selection'));
  const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  try {
    act(() =>
      probe.result.current.edit({ put: { indices: [29], turn: { commandKey: 'farm', args: {}, explicit: true } } }),
    );
    expect(probe.result.current.draft?.turns[29]?.commandKey).toBe('farm');
    act(() => selection.result.current[1](new Set([29])));
    expect([...selection.result.current[0]]).toEqual([29]);
  } finally {
    blocked.mockRestore();
  }
});
