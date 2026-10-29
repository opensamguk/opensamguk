import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import { processWorldCreateRequest } from './admin/createRequests';
import { DISCOVERY_MS, runSupervisor } from './supervisor';

vi.mock('./admin/createRequests', () => ({ processWorldCreateRequest: vi.fn() }));
let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
function fixture() {
  const controller = new AbortController(),
    findMany = vi.fn(async () => []),
    spawnChild = vi.fn(),
    onEvent = vi.fn();
  const done = runSupervisor({ world: { findMany } } as unknown as PrismaClient, {
    signal: controller.signal,
    spawnChild,
    onEvent,
  });
  return { controller, findMany, spawnChild, onEvent, done };
}
it('생성 소비는 월드 발견을 막지 않고 중복 실행 없이 종료 때 정착한다', async () => {
  let finish!: (value: boolean) => void;
  vi.mocked(processWorldCreateRequest).mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const f = fixture();
  await vi.waitUntil(() => f.findMany.mock.calls.length === 1, { interval: 10 });
  clock = DISCOVERY_MS + 1;
  await vi.waitUntil(() => f.findMany.mock.calls.length === 2, { interval: 10 });
  expect(f.findMany).toHaveBeenCalledTimes(2);
  expect(processWorldCreateRequest).toHaveBeenCalledTimes(1);
  expect(f.spawnChild).not.toHaveBeenCalled();
  let settled = false;
  void f.done.then(() => (settled = true));
  f.controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(settled).toBe(false);
  finish(true);
  await f.done;
  expect(settled).toBe(true);
});
it('생성의 일시 오류는 고정 사건만 내고 다음 발견 때 다시 소비한다', async () => {
  vi.mocked(processWorldCreateRequest).mockRejectedValueOnce(new Error('private failure')).mockResolvedValue(false);
  const f = fixture();
  await vi.waitUntil(() => f.findMany.mock.calls.length === 1, { interval: 10 });
  clock = DISCOVERY_MS + 1;
  await vi.waitUntil(() => f.findMany.mock.calls.length === 2, { interval: 10 });
  f.controller.abort();
  await f.done;
  expect(processWorldCreateRequest).toHaveBeenCalledTimes(2);
  expect(f.onEvent.mock.calls).toEqual([[{ kind: 'creation-error' }]]);
});
it('종료 신호 뒤의 소비 거절은 오류 사건을 새로 내지 않는다', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(processWorldCreateRequest).mockReturnValue(new Promise((_resolve, fail) => (reject = fail)));
  const f = fixture();
  await new Promise((resolve) => setTimeout(resolve, 120));
  f.controller.abort();
  reject(new Error('aborted'));
  await f.done;
  expect(f.onEvent).not.toHaveBeenCalled();
});
