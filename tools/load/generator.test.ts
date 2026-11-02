import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { LoadHttpClient } from './http';
import { runNativeLoad } from './generator';
import type { GeneratorEvent } from './journal';

// HTTP 응답을 메모리 스트림으로 대체한 순수 계약 검사다. 실제 API/PG 부하 인수가 아니다.
describe('L4 생성기 후크와 전체 본문 시간', () => {
  it('attempt 영속 대기와 본문 소비를 모두 duration에 포함하고 취소 후 새 후크를 내보내지 않는다', async () => {
    let clock = 0,
      abortedEvents = 0;
    const controller = new AbortController(),
      events: GeneratorEvent[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/sse') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('event: ready\ndata: {"kind":"ready"}\n\n'));
              init?.signal?.addEventListener('abort', () => stream.error(new DOMException('stopped', 'AbortError')), {
                once: true,
              });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const procedure = url.pathname.slice('/trpc/'.length);
      const data =
        procedure === 'home.get'
          ? { general: { cityKey: 1 } }
          : procedure === 'world.map'
            ? { nations: [{ id: 1 }] }
            : { revision: 0, slots: Array.from({ length: 30 }, (_, slot) => ({ slot, commandKey: 'rest', args: {} })) };
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(stream) {
            clock += 60;
            stream.enqueue(new TextEncoder().encode(JSON.stringify({ result: { data } })));
            stream.close();
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const worlds = ([1, 2] as const).map((turnTermMinutes) => {
        const worldId = randomUUID();
        const actors = Array.from({ length: 109 }, (_, index) => ({
          worldId,
          userId: randomUUID(),
          generalId: index + 1,
          client: new LoadHttpClient('http://server:3001', 'http://server:3001', 'a'.repeat(43)),
        }));
        return {
          worldId,
          turnTermMinutes,
          actors,
          users: actors.slice(0, 50),
          profile: {
            scenario: 'integration191' as const,
            map: 'integration' as const,
            startYear: 191,
            historicalGeneralIds: [],
            nations: 21,
            cities: 53,
            passes: 8,
            ports: 6,
            fields: 13,
          },
        };
      });
      const run = await runNativeLoad(worlds, {
        mode: 'smoke',
        seed: 'hook-unit',
        signal: controller.signal,
        onEvent: async (event) => {
          if (controller.signal.aborted) abortedEvents++;
          events.push(event);
          if (event.kind === 'attempt') clock += 40;
          if (event.kind === 'complete') controller.abort();
        },
      });
      expect(run.requests.length).toBeGreaterThan(0);
      expect(run.requests.every((sample) => sample.durationMs >= 100)).toBe(true);
      expect(events.some((event) => event.kind === 'attempt')).toBe(true);
      expect(events.filter((event) => event.kind === 'complete')).toHaveLength(1);
      expect(abortedEvents).toBe(0);
      expect(run.complete).toBe(false);
      expect(run.generatorFailures.length).toBeGreaterThan(0);
    } finally {
      controller.abort();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
