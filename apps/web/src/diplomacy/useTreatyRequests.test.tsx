// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInput, RequestState } from './contract';
import { requestsStorageKey } from './requests';
import { useTreatyRequests } from './useTreatyRequests';

// 보내기와 결과 조회만 가짜로 바꾼다. 화면이 sessionStorage와 requestId를 어떻게 다루는지 본다.
// 응답 값은 실제 AppRouter의 TreatyRequestState 타입으로 만든 것이고 서버 실행의 증거가 아니다.
const sendAction = vi.fn<(worldId: string, requestId: string, action: ActionInput) => Promise<RequestState>>();
const fetchRequest = vi.fn<(worldId: string, requestId: string) => Promise<RequestState>>();
vi.mock('./contract', () => ({
  sendAction: (...args: Parameters<typeof sendAction>) => sendAction(...args),
  fetchRequest: (...args: Parameters<typeof fetchRequest>) => fetchRequest(...args),
  TREATY_PATH_KEY: [['treaty']],
}));

const KEY = requestsStorageKey('u1', 'w1');
const accept: ActionInput = { kind: 'treaty.respond', input: { treatyId: '7', accept: true } };
const applied = (requestId: string): RequestState => ({
  status: 'applied',
  requestId,
  kind: 'treaty.respond',
  outcome: 'ACCEPTED',
  treatyId: '7',
  treaty: null,
});
const serverError = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32603, data: { code } } });

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient();
  sessionStorage.clear();
  sendAction.mockReset();
  fetchRequest.mockReset();
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
      return Promise.resolve({ status: 'pending', requestId, kind: 'treaty.respond' });
    });
    fetchRequest.mockResolvedValueOnce({ status: 'pending', requestId: 'x', kind: 'treaty.respond' });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });

    let id = '';
    await act(async () => {
      id = result.current.send(accept);
      await Promise.resolve();
    });
    expect(JSON.parse(storedAtSend!)).toEqual([{ requestId: id, action: accept }]);
    expect(result.current.tracked[0]?.phase).toBe('pending');
    expect(invalidate).not.toHaveBeenCalled();

    fetchRequest.mockImplementation((_w, requestId) => Promise.resolve(applied(requestId)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(fetchRequest.mock.calls.every(([, requestId]) => requestId === id)).toBe(true);
    expect(result.current.tracked).toEqual([]);
    expect(result.current.finished[0]).toMatchObject({ requestId: id, result: 'applied', outcome: 'ACCEPTED' });
    expect(sessionStorage.getItem(KEY)).toBeNull();
    // 끝난 요청의 조약은 ID만 담으므로 카드 전체는 목록을 다시 받아 갱신한다.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [['treaty']] });
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
    expect(JSON.parse(sessionStorage.getItem(KEY)!)).toEqual([{ requestId: id, action: accept }]);

    sendAction.mockImplementation((_w, requestId) => Promise.resolve(applied(requestId)));
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

  it('INTERNAL_SERVER_ERROR는 확정 거절로 보지 않고 같은 requestId로 되찾는다. 그 결과가 HTTP 200 rejected면 엔진 거절로 끝낸다', async () => {
    sendAction.mockRejectedValueOnce(serverError('INTERNAL_SERVER_ERROR', '조약 요청 기록을 확인하지 못했습니다.'));
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });
    let id = '';
    await act(async () => {
      id = result.current.send(accept);
      await Promise.resolve();
    });
    expect(result.current.tracked[0]?.phase).toBe('unknown');
    expect(result.current.finished).toEqual([]);

    sendAction.mockImplementation((_w, requestId) =>
      Promise.resolve({
        status: 'rejected',
        requestId,
        kind: 'treaty.respond',
        code: 'INSUFFICIENT_GOLD',
        reason: '국고가 모자랍니다.',
      }),
    );
    await act(async () => {
      result.current.resend(id);
      await Promise.resolve();
    });
    expect(sendAction.mock.calls.map(([, requestId]) => requestId)).toEqual([id, id]);
    expect(result.current.finished[0]).toMatchObject({
      requestId: id,
      result: 'rejected',
      reason: '국고가 모자랍니다.',
    });
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('접수 단계의 CONFLICT는 다시 보내지 않고 서버가 받지 않은 요청으로 끝낸다', async () => {
    sendAction.mockRejectedValueOnce(serverError('CONFLICT', '요청을 처리하는 중입니다.'));
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });
    await act(async () => {
      result.current.send(accept);
      await Promise.resolve();
    });
    expect(result.current.tracked).toEqual([]);
    expect(result.current.finished[0]).toMatchObject({ result: 'refused', reason: '요청을 처리하는 중입니다.' });
    expect(sendAction).toHaveBeenCalledOnce();
  });

  it('새로 고침 뒤에는 저장한 requestId의 결과를 다시 묻는다', async () => {
    sessionStorage.setItem(KEY, JSON.stringify([{ requestId: 'r9', action: accept }]));
    fetchRequest.mockResolvedValue({
      status: 'rejected',
      requestId: 'r9',
      kind: 'treaty.respond',
      code: 'EXPIRED',
      reason: '기한이 지났습니다.',
    });
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });
    expect(result.current.tracked[0]).toMatchObject({ requestId: 'r9', phase: 'checking' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(fetchRequest).toHaveBeenCalledWith('w1', 'r9');
    expect(result.current.finished[0]).toMatchObject({ result: 'rejected', reason: '기한이 지났습니다.' });
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('v1 저장값(expiresInMonths가 든 옛 제안)은 v2 키로 읽지 않아 묻지도 다시 보내지도 않는다', async () => {
    const v1 = 'opensamguk.treatyRequests.v1:u1:w1';
    const old = {
      kind: 'propose',
      input: { toNationId: 2, clauses: [{ kind: 'trade', months: 6 }], expiresInMonths: 6 },
    };
    sessionStorage.setItem(v1, JSON.stringify([{ requestId: 'old', action: old }]));
    const { result } = renderHook(() => useTreatyRequests('w1', KEY), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(KEY).not.toBe(v1);
    expect(result.current.tracked).toEqual([]);
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(sendAction).not.toHaveBeenCalled();
  });
});
