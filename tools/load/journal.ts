import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import { WORKLOAD_WEIGHTS } from './workload';
import type { WorkloadProcedure } from './workload';
import type { RequestSample } from './report';

type Slot = Readonly<{ worldIndex: number; userIndex: number }>;
// 전용 원자료에도 계정·쿠키·요청/응답 본문·오류 원문을 전달하지 않는다.
export type GeneratorEvent =
  | Readonly<{ kind: 'start'; at: number; measurementStartedAt: number; measurementFinishedAt: number }>
  | (Slot & Readonly<{ kind: 'sse'; state: 'ready'; at: number }>)
  | (Slot & Readonly<{ kind: 'worker'; state: 'started' | 'window-complete'; at: number }>)
  | (Slot & Readonly<{ kind: 'attempt'; sequence: number; procedure: WorkloadProcedure; thinkMs: number; at: number }>)
  | (Slot &
      Readonly<{
        kind: 'complete';
        sequence: number;
        at: number;
        durationMs: number;
        status: number;
        outcome: RequestSample['outcome'];
      }>);
export type GeneratorEventSink = (event: GeneratorEvent) => Promise<void>;
const at = z.number().finite().nonnegative();
const slot = { worldIndex: z.number().int().min(0).max(1), userIndex: z.number().int().min(0).max(49) };
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('start'), at, measurementStartedAt: at, measurementFinishedAt: at }),
  z.strictObject({ kind: z.literal('sse'), ...slot, state: z.literal('ready'), at }),
  z.strictObject({ kind: z.literal('worker'), ...slot, state: z.enum(['started', 'window-complete']), at }),
  z.strictObject({
    kind: z.literal('attempt'),
    ...slot,
    sequence: z.number().int().positive(),
    procedure: z.enum(WORKLOAD_WEIGHTS.map((entry) => entry.procedure)),
    thinkMs: z.number().int().min(1000).max(3000),
    at,
  }),
  z.strictObject({
    kind: z.literal('complete'),
    ...slot,
    sequence: z.number().int().positive(),
    at,
    durationMs: at,
    status: z.number().int().min(0).max(599),
    outcome: z.enum(['success', 'stale', 'http-error', 'network-error', 'protocol-error']),
  }),
]);

export async function emitGeneratorEvent(
  sink: GeneratorEventSink,
  event: GeneratorEvent,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await sink(event);
  signal.throwIfAborted();
}

export function nativeJournal(
  path: string,
  append = appendFile,
): {
  sink: GeneratorEventSink;
  close: () => Promise<void>;
  healthy: () => boolean;
} {
  let tail: Promise<void> = Promise.resolve(),
    failed = false,
    bytes = 0;
  let pending = 0,
    closed = false;
  const sink: GeneratorEventSink = async (event) => {
    if (closed || failed) throw new Error('LOAD_JOURNAL_UNAVAILABLE');
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) {
      failed = true;
      throw new Error('LOAD_JOURNAL_EVENT_INVALID');
    }
    const text = JSON.stringify(parsed.data) + '\n';
    bytes += Buffer.byteLength(text);
    if (bytes > 256 * 1024 * 1024 || pending >= 1024) {
      failed = true;
      throw new Error('LOAD_JOURNAL_LIMIT');
    }
    pending++;
    const operation = tail.then(async () => {
      if (failed) throw new Error('LOAD_JOURNAL_UNAVAILABLE');
      await append(path, text, { encoding: 'utf8', mode: 0o600 });
    });
    tail = operation.catch(() => {
      failed = true;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        operation.then(() => true),
        new Promise<false>((done) => {
          timer = setTimeout(() => done(false), 2_000);
        }),
      ]);
      if (!settled) {
        failed = true;
        throw new Error('LOAD_JOURNAL_UNSETTLED');
      }
    } catch {
      failed = true;
      throw new Error('LOAD_JOURNAL_FAILED');
    } finally {
      if (timer) clearTimeout(timer);
      void operation
        .finally(() => {
          pending--;
        })
        .catch(() => {});
    }
  };
  return {
    sink,
    healthy: () => !failed && pending === 0,
    close: async () => {
      closed = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([
          tail.then(() => true),
          new Promise<false>((done) => {
            timer = setTimeout(() => done(false), 2_000);
          }),
        ]);
        if (!settled || failed || pending !== 0) throw new Error('LOAD_JOURNAL_NOT_CLOSED');
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
