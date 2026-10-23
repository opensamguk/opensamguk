// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInput, InputOutcome, RequestState } from './contract';
import { useTreatyRequests } from './useTreatyRequests';

// 보내기와 결과 조회만 가짜로 바꾼다. 화면이 sessionStorage와 requestId를 어떻게 다루는지 본다.
const sendAction = vi.fn<(worldId: string, requestId: string, action: ActionInput) => Promise<InputOutcome>>();
const requestQuery = vi.fn<(input: { worldId: string; requestId: string }) => Promise<RequestState>>();
vi.mock('./contract', () => ({
  sendAction: (...args: Parameters<typeof sendAction>) => sendAction(...args),
  treatyApi: { request: { query: (input: { worldId: string; requestId: string }) => requestQuery(input) } },
  TREATY_PATH_KEY: [['treaty']],
}));

const KEY = 'opensamguk.treatyRequests.v1:u1:w1';
const accept: ActionInput = { kind: 'respond', input: { treatyId: 't1', accept: true } };

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  sessionStorage.clear();
  sendAction.mockReset();
  requestQuery.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTreatyRequests', () => {
  it('보내기 전에 requestId를 저장하고 pending이면 1초마다 같은 requestId로 결과를 묻는다', async () => {
    let storedAtSend: string | null = null;
    sendAction.mockImplementation((_w, requestId) => {
      storedAtSend = sessionStorage.getItem(KEY);
      return Promise.resolve({ status: 'pending', requestId });
    });
    requestQuery.mockResolvedValueOnce({ status: 'pending', requestId: 'x' });
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });

    let id = '';
    await act(async () => {
      id = result.current.send(accept);
      await Promise.resolve();
    });
    expect(JSON.parse(storedAtSend!)).toEqual([{ requestId: id, action: accept }]);
    expect(result.current.tracked[0]?.phase).toBe('pending');

    requestQuery.mockImplementation(({ requestId }) => Promise.resolve({ status: 'applied', requestId, treaty: null }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(requestQuery.mock.calls.every(([input]) => input.requestId === id)).toBe(true);
    expect(result.current.tracked).toEqual([]);
    expect(result.current.finished[0]).toMatchObject({ requestId: id, result: 'applied' });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('응답을 잃으면 같은 requestId와 같은 내용으로 다시 보낸다', async () => {
    sendAction.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });
    let id = '';
    await act(async () => {
      id = result.current.send(accept);
      await Promise.resolve();
    });
    expect(result.current.tracked[0]?.phase).toBe('unknown');

    sendAction.mockImplementation((_w, requestId) => Promise.resolve({ status: 'applied', requestId, treaty: null }));
    await act(async () => {
      result.current.resend(id);
      await Promise.resolve();
    });
    expect(sendAction.mock.calls.map(([, requestId, action]) => [requestId, action])).toEqual([
      [id, accept],
      [id, accept],
    ]);
    expect(result.current.finished[0]?.result).toBe('applied');
  });

  it('새로 고침 뒤에는 저장한 requestId의 결과를 다시 묻는다', async () => {
    sessionStorage.setItem(KEY, JSON.stringify([{ requestId: 'r9', action: accept }]));
    requestQuery.mockResolvedValue({ status: 'rejected', requestId: 'r9', code: 'X', reason: '기한이 지났습니다.' });
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });
    expect(result.current.tracked[0]).toMatchObject({ requestId: 'r9', phase: 'checking' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(requestQuery).toHaveBeenCalledWith({ worldId: 'w1', requestId: 'r9' });
    expect(result.current.finished[0]).toMatchObject({ result: 'rejected', reason: '기한이 지났습니다.' });
    expect(sendAction).not.toHaveBeenCalled();
  });
});
