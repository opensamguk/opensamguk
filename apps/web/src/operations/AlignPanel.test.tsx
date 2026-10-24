// @vitest-environment jsdom
import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRPCProvider } from '../trpc';
import type { DisplaySlot } from '../turns/source';
import { AlignPanel, type AlignDraft } from './AlignPanel';
import type { SlotView, Suggestion, SuggestionNoop } from './contract';

// AppRouter 출력 모양의 가짜 제안. 가짜 링크라 실제 API 증거가 아니다.
// 화면이 메인 초안 훅의 edit만 부르고 따로 저장(turns.set)하지 않는지 링크에서 경로를 센다.
const blank: SlotView = { commandKey: 'rest', args: {}, explicit: false, name: '휴식' };
const current: SlotView[] = Array.from({ length: 30 }, () => blank);
const slots = [...current];
slots[2] = { commandKey: 'train', args: {}, explicit: true, name: '훈련' };
slots[5] = { commandKey: 'attack', args: { cityKey: 12 }, explicit: true, name: '출병' };
const base: Suggestion = { revision: 3, current, slots, changed: [2, 5], warnings: [], noop: null };

afterEach(cleanup);

// 제안 응답. Promise면 시험이 resolve·reject할 때까지 응답을 미룬다.
type Answer = () => Suggestion | Promise<Suggestion>;

function fakeServer(answer: Answer) {
  const calls: Record<string, number> = {};
  const inputs: unknown[] = [];
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        calls[op.path] = (calls[op.path] ?? 0) + 1;
        inputs.push(op.input);
        if (op.path !== 'operation.suggest') {
          observer.error(TRPCClientError.from(new Error(`unexpected ${op.path}`)));
          return;
        }
        const result = answer();
        const reply = (data: Suggestion) => {
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        };
        if (result instanceof Promise)
          result.then(reply, (error: unknown) =>
            observer.error(error instanceof TRPCClientError ? error : TRPCClientError.from(error as Error)),
          );
        else reply(result);
      });
  return { client: createTRPCClient<AppRouter>({ links: [link] }), calls, inputs };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// 차례대로 답한다. 첫 응답은 바로, 그 뒤는 시험이 정한 대로다.
const inOrder = (...answers: Answer[]): Answer => {
  let n = 0;
  return () => answers[Math.min(n++, answers.length - 1)]!();
};

const serverError = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32000, data: { code } } });

const serverList = { revision: 3, slots: current satisfies DisplaySlot[] };
function draftState(ops: number, patch: Partial<AlignDraft> = {}): AlignDraft {
  return {
    draft: ops > 0 ? { baseRevision: 3, ops: Array.from({ length: ops }, () => ({ shift: 1 })), turns: [] } : null,
    pending: null,
    notice: null,
    saving: false,
    server: { data: serverList },
    edit: vi.fn(),
    ...patch,
  };
}

function renderPanel(draft: AlignDraft, answer: Answer = () => base) {
  const server = fakeServer(answer);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 같은 패널 인스턴스에 작전만 바꿔 다시 그릴 수 있다. 컴포넌트 key는 주지 않는다.
  const ui = (d: AlignDraft, operationId: string) => (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={server.client} queryClient={queryClient}>
        <AlignPanel
          worldId="w1"
          operationId={operationId}
          draft={d}
          names={{ city: (k) => (k === 12 ? '복양' : undefined), nation: () => undefined }}
        />
      </TRPCProvider>
    </QueryClientProvider>
  );
  const view = render(ui(draft, 'op1'));
  return {
    calls: server.calls,
    inputs: server.inputs,
    rerender: (d: AlignDraft, operationId = 'op1') => view.rerender(ui(d, operationId)),
  };
}

const open = () => fireEvent.click(screen.getByRole('button', { name: '내 예턴을 작전에 맞추기' }));

describe('작전에 맞추기 패널', () => {
  it('바뀌는 칸을 보여 주고 넣으면 칸마다 edit(put)만 부르고 저장 경로는 부르지 않는다', async () => {
    const draft = draftState(0);
    const { calls } = renderPanel(draft);
    open();
    expect(await screen.findByText('출병 복양')).toBeTruthy();
    // 지금 칸은 비워 둔 칸이라 직접 넣은 휴식과 다른 글자로 보인다.
    expect(screen.getAllByText('빈 칸')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '초안에 넣기' }));
    expect(draft.edit).toHaveBeenCalledTimes(2);
    expect(draft.edit).toHaveBeenLastCalledWith({
      put: { indices: [5], turn: { commandKey: 'attack', args: { cityKey: 12 }, explicit: true } },
    });
    expect(screen.getByRole('status').textContent).toContain('제안 2칸을 초안에 넣었습니다');
    expect(Object.keys(calls)).toEqual(['operation.suggest']);
  });

  it('저장하지 않은 편집이 있으면 덮기 전에 묻고 취소하면 초안을 건드리지 않는다', async () => {
    const draft = draftState(2);
    renderPanel(draft);
    open();
    await screen.findByText('출병 복양');
    fireEvent.click(screen.getByRole('button', { name: '초안에 넣기' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('저장하지 않은 편집 2건');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(draft.edit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '초안에 넣기' }));
    fireEvent.click(screen.getByRole('button', { name: '덮고 넣기' }));
    expect(draft.edit).toHaveBeenCalledTimes(2);
  });

  it('미리보기를 닫으면 초안을 그대로 둔다', async () => {
    const draft = draftState(1);
    renderPanel(draft);
    open();
    await screen.findByText('출병 복양');
    fireEvent.click(screen.getByRole('button', { name: '미리보기 닫기' }));
    expect(draft.edit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('align-preview')).toBeNull();
  });

  const noops: SuggestionNoop[] = [
    { code: 'NO_SLOT', reason: '목표 전에 실행할 예턴 칸이 없습니다.' },
    { code: 'BEYOND_WINDOW', reason: '목표가 지금 예턴 30칸 밖에 있습니다.' },
    { code: 'NO_ROOM', reason: '목표 전에 준비 명령을 넣을 칸이 부족합니다.' },
    { code: 'UNREACHABLE', reason: '훈련과 사기 기준에 도달할 수 없습니다.' },
  ];
  it.each(noops)('noop $code면 서버 문장을 보이고 넣기를 그 문장으로 막는다', async (noop) => {
    const draft = draftState(0);
    renderPanel(draft, () => ({ ...base, slots: current, changed: [], noop }));
    open();
    const shown = await screen.findByText(noop.reason);
    expect(shown.getAttribute('data-noop')).toBe(noop.code);
    expect(screen.queryByText('지금 예턴이 이미 작전 제안과 같습니다.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /초안에 넣기/ }));
    expect(screen.getByRole('note').textContent).toBe(noop.reason);
    expect(draft.edit).not.toHaveBeenCalled();
  });

  it('noop이 없고 바뀌는 칸이 없을 때만 같은 예턴이라고 적고 넣기를 막는다', async () => {
    const draft = draftState(0);
    renderPanel(draft, () => ({ ...base, slots: current, changed: [] }));
    open();
    expect(await screen.findByText('지금 예턴이 이미 작전 제안과 같습니다.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /초안에 넣기/ }));
    expect(screen.getByRole('note').textContent).toBe('바꿀 칸이 없습니다.');
    expect(draft.edit).not.toHaveBeenCalled();
  });

  it('한 칸의 여러 경고와 바뀌지 않는 칸의 경고를 빠짐없이 보이고 가능하다고 적지 않는다', async () => {
    renderPanel(draftState(0), () => ({
      ...base,
      warnings: [
        { slot: 0, code: 'SORTIE_MOVED', reason: '목표 도시 출병을 목표 전 마지막 칸으로 옮깁니다.' },
        { slot: 5, code: 'NO_CREW', reason: '병사가 없습니다.' },
        { slot: 5, code: 'NO_RICE', reason: '군량이 부족합니다.' },
      ],
    }));
    open();
    await screen.findByText('출병 복양');
    const row = screen.getByText('출병 복양').closest('tr')!;
    expect([...row.querySelectorAll('li')].map((li) => li.getAttribute('data-code'))).toEqual(['NO_CREW', 'NO_RICE']);
    expect(row.textContent).toContain('병사가 없습니다.');
    expect(row.textContent).toContain('군량이 부족합니다.');
    const trainRow = screen.getByText('훈련').closest('tr')!;
    expect(trainRow.textContent).toContain('지금 상태 경고 없음');
    const outside = screen.getByTestId('align-outside-warnings');
    expect(outside.textContent).toContain('1번 칸. 목표 도시 출병을 목표 전 마지막 칸으로 옮깁니다.');
    expect(screen.queryByText('가능')).toBeNull();
  });

  it('저장 충돌(STALE)이면 제안을 다시 받고 고치던 초안은 건드리지 않으며 넣기를 막는다', async () => {
    const draft = draftState(2);
    const { calls, rerender } = renderPanel(draft);
    open();
    await screen.findByText('출병 복양');
    expect(calls['operation.suggest']).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '미리보기 닫기' }));
    // 편집기의 STALE 흐름: 초안은 pending으로 옮겨 가고 notice가 stale이 된다.
    rerender({ ...draft, draft: null, pending: { ops: [{ shift: 1 }, { shift: 1 }] }, notice: { kind: 'stale' } });
    await waitFor(() => expect(calls['operation.suggest']).toBe(2));
    expect(screen.getByRole('alert').textContent).toContain('다른 곳에서 예턴이 바뀌었습니다');
    expect(screen.getByTestId('align-preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /초안에 넣기/ }));
    expect(screen.getByRole('note').textContent).toBe('먼저 편집기의 충돌 안내에서 다시 적용할지 고르세요.');
    expect(draft.edit).not.toHaveBeenCalled();
  });

  // 편집기의 STALE 흐름과 [내 편집 다시 적용] 뒤 상태. 초안은 pending으로 갔다가 다시 draft로 돌아온다.
  const staleOf = (draft: AlignDraft): AlignDraft => ({
    ...draft,
    draft: null,
    pending: { ops: draft.draft?.ops ?? [] },
    notice: { kind: 'stale' },
  });
  const reappliedOf = (draft: AlignDraft): AlignDraft => ({ ...draft, notice: { kind: 'reapplied' } });
  // STALE 뒤 최신 30칸 기준 새 제안. 이전 제안과 바뀌는 칸·인자가 다르다.
  const fresh: Suggestion = (() => {
    const next = [...current];
    next[7] = { commandKey: 'recruit', args: { amount: 700 }, explicit: true, name: '모병' };
    return { revision: 4, current, slots: next, changed: [7], warnings: [], noop: null };
  })();

  it('STALE 뒤 새 제안이 오기 전에는 이미 열린 덮기 확인으로도 이전 제안을 넣지 않고, 온 뒤에는 새 칸만 넣는다', async () => {
    const later = deferred<Suggestion>();
    const draft = draftState(2);
    const { calls, rerender } = renderPanel(
      draft,
      inOrder(
        () => base,
        () => later.promise,
      ),
    );
    open();
    await screen.findByText('출병 복양');
    fireEvent.click(screen.getByRole('button', { name: '초안에 넣기' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('저장하지 않은 편집 2건');
    rerender(staleOf(draft));
    await waitFor(() => expect(calls['operation.suggest']).toBe(2));
    // 사용자가 새 응답 전에 충돌 안내를 해소했다. 이전 제안은 아직 캐시에 남아 있다.
    rerender(reappliedOf(draft));
    expect(screen.getByText('출병 복양')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /덮고 넣기/ }));
    expect(draft.edit).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toContain('최신 예턴 기준 제안을 다시 받는 중입니다');

    later.resolve(fresh);
    expect(await screen.findByText('모병 수량 700')).toBeTruthy();
    expect(screen.queryByText('출병 복양')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '덮고 넣기' }));
    expect(draft.edit).toHaveBeenCalledTimes(1);
    expect(draft.edit).toHaveBeenCalledWith({
      put: { indices: [7], turn: { commandKey: 'recruit', args: { amount: 700 }, explicit: true } },
    });
  });

  it('STALE 뒤 제안이 오기 전에는 다시 받는 중이라고 적고 새 응답이 온 뒤에만 다시 받았다고 적는다', async () => {
    const later = deferred<Suggestion>();
    const draft = draftState(1);
    const { calls, rerender } = renderPanel(
      draft,
      inOrder(
        () => base,
        () => later.promise,
      ),
    );
    open();
    await screen.findByText('출병 복양');
    rerender(staleOf(draft));
    await waitFor(() => expect(calls['operation.suggest']).toBe(2));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('다시 받았습니다');
    expect(alert.textContent).toContain('다시 받는 중입니다');
    later.resolve(fresh);
    await screen.findByText('모병 수량 700');
    expect(screen.getByRole('alert').textContent).toContain('최신 예턴 기준으로 비교를 다시 받았습니다');
  });

  it('STALE 뒤 제안을 다시 받지 못하면 서버 문장을 보이고 이전 제안으로 넣지 않는다', async () => {
    const later = deferred<Suggestion>();
    const draft = draftState(0);
    const { calls, rerender } = renderPanel(
      draft,
      inOrder(
        () => base,
        () => later.promise,
      ),
    );
    open();
    await screen.findByText('출병 복양');
    rerender(staleOf(draft));
    await waitFor(() => expect(calls['operation.suggest']).toBe(2));
    later.reject(serverError('FORBIDDEN', '참여 장수만 제안을 받을 수 있습니다.'));
    expect(await screen.findByText('참여 장수만 제안을 받을 수 있습니다.')).toBeTruthy();
    rerender(reappliedOf(draft));
    fireEvent.click(screen.getByRole('button', { name: /초안에 넣기/ }));
    expect(draft.edit).not.toHaveBeenCalled();
    expect(screen.getByRole('note').textContent).toContain('제안을 다시 받지 못해');
  });

  it('한 작전에서 STALE을 두 번 겪은 뒤 같은 패널로 다른 작전에 가도 그 작전의 새 제안은 넣을 수 있다', async () => {
    // B 작전 제안. A의 제안들과 바뀌는 칸·인자가 다르다.
    const forB: Suggestion = (() => {
      const next = [...current];
      next[9] = { commandKey: 'recruit', args: { amount: 300 }, explicit: true, name: '모병' };
      return { revision: 8, current, slots: next, changed: [9], warnings: [], noop: null };
    })();
    const draft = draftState(0);
    const { calls, inputs, rerender } = renderPanel(
      draft,
      inOrder(
        () => base,
        () => fresh,
        () => fresh,
        () => forB,
      ),
    );
    open();
    await screen.findByText('출병 복양');
    // A에서 STALE 두 번. 두 번째 STALE을 볼 때 A 제안 응답은 이미 2번 왔다.
    rerender(staleOf(draft));
    await screen.findByText('최신 예턴 기준으로 비교를 다시 받았습니다.', { exact: false });
    rerender(reappliedOf(draft));
    rerender(staleOf(draft));
    await waitFor(() => expect(calls['operation.suggest']).toBe(3));
    await screen.findByText('최신 예턴 기준으로 비교를 다시 받았습니다.', { exact: false });
    rerender(reappliedOf(draft));
    expect(screen.getByText('모병 수량 700')).toBeTruthy();

    rerender(reappliedOf(draft), 'op2');
    expect(await screen.findByText('모병 수량 300')).toBeTruthy();
    expect(calls['operation.suggest']).toBe(4);
    expect(inputs.at(-1)).toEqual({ worldId: 'w1', id: 'op2' });
    expect(screen.queryByText('모병 수량 700')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /초안에 넣기/ }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(draft.edit).toHaveBeenCalledTimes(1);
    expect(draft.edit).toHaveBeenCalledWith({
      put: { indices: [9], turn: { commandKey: 'recruit', args: { amount: 300 }, explicit: true } },
    });
  });

  it('저장 중에는 넣기를 막는다', async () => {
    const draft = draftState(0, { saving: true });
    renderPanel(draft);
    open();
    await screen.findByText('출병 복양');
    fireEvent.click(screen.getByRole('button', { name: /초안에 넣기/ }));
    expect(screen.getByRole('note').textContent).toBe('저장하는 중입니다.');
    expect(draft.edit).not.toHaveBeenCalled();
  });
});
