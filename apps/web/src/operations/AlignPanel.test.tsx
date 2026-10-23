// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnDraftState } from '../turns/useTurnDraft';
import { AlignPanel } from './AlignPanel';
import type { SlotView, Suggestion } from './contract';

// 제안 조회만 가짜로 둔다. 화면이 메인 초안 훅의 edit만 부르고 따로 저장하지 않는지 본다.
const rest: SlotView = { commandKey: 'rest', args: {}, name: '휴식' };
const current = Array.from({ length: 30 }, () => rest);
const slots = [...current];
slots[2] = { commandKey: 'train', args: {}, name: '훈련' };
slots[5] = { commandKey: 'attack', args: { cityKey: 12 }, name: '출병' };
const suggestion: Suggestion = { revision: 3, current, slots, changed: [2, 5], warnings: [] };
const suggest = vi.fn(() => Promise.resolve(suggestion));
vi.mock('./contract', () => ({
  operationApi: { suggest: { query: () => suggest() } },
  operationQueryKey: (procedure: string, input: unknown) => [['operation', procedure], { input, type: 'query' }],
}));

afterEach(cleanup);

const draftState = (ops: number) =>
  ({
    draft: ops > 0 ? { baseRevision: 3, ops: Array.from({ length: ops }, () => ({ shift: 1 })), turns: [] } : null,
    pending: null,
    notice: null,
    saving: false,
    server: { data: { revision: 3, slots: current } },
    edit: vi.fn(),
    submit: vi.fn(),
  }) as unknown as TurnDraftState;

function renderPanel(draft: TurnDraftState) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AlignPanel
        worldId="w1"
        operationId="op1"
        draft={draft}
        names={{ city: (k) => (k === 12 ? '복양' : undefined), nation: () => undefined }}
      />
    </QueryClientProvider>,
  );
}

describe('작전에 맞추기 패널', () => {
  it('바뀌는 칸을 보여 주고 넣으면 칸마다 edit(put)만 부른다', async () => {
    const draft = draftState(0);
    renderPanel(draft);
    fireEvent.click(screen.getByRole('button', { name: '내 예턴을 작전에 맞추기' }));
    expect(await screen.findByText('출병 복양')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '초안에 넣기' }));
    expect(draft.edit).toHaveBeenCalledTimes(2);
    expect(draft.edit).toHaveBeenLastCalledWith({
      put: { indices: [5], turn: { commandKey: 'attack', args: { cityKey: 12 } } },
    });
    expect(draft.submit).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('제안 2칸을 초안에 넣었습니다');
  });

  it('저장하지 않은 편집이 있으면 덮기 전에 묻고 취소하면 초안을 건드리지 않는다', async () => {
    const draft = draftState(2);
    renderPanel(draft);
    fireEvent.click(screen.getByRole('button', { name: '내 예턴을 작전에 맞추기' }));
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
    fireEvent.click(screen.getByRole('button', { name: '내 예턴을 작전에 맞추기' }));
    await screen.findByText('출병 복양');
    fireEvent.click(screen.getByRole('button', { name: '미리보기 닫기' }));
    expect(draft.edit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('align-preview')).toBeNull();
  });
});
