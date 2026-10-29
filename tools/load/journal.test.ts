import { describe, expect, it, vi } from 'vitest';
import { emitGeneratorEvent, nativeJournal, type GeneratorEvent } from './journal';

const event: GeneratorEvent = {
  kind: 'attempt',
  worldIndex: 0,
  userIndex: 0,
  sequence: 1,
  procedure: 'home.get',
  thinkMs: 1000,
  at: 1,
};
describe('L4 원자료 영속 후크', () => {
  it('후크 await 중 취소되면 후속 HTTP·이벤트를 시작하지 않는다', async () => {
    const controller = new AbortController();
    let nextActions = 0;
    const operation = async () => {
      await emitGeneratorEvent(
        async () => {
          controller.abort();
        },
        event,
        controller.signal,
      );
      nextActions++;
    };
    await expect(operation()).rejects.toThrow();
    await expect(
      emitGeneratorEvent(
        async () => {
          nextActions++;
        },
        event,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(nextActions).toBe(0);
  });
  it('쓰기 정착 전에는 후속 요청을 실행하지 않는다', async () => {
    let finish!: () => void,
      actions = 0;
    const pending = new Promise<void>((done) => {
      finish = done;
    });
    const operation = (async () => {
      await emitGeneratorEvent(async () => pending, event, new AbortController().signal);
      actions++;
    })();
    await Promise.resolve();
    expect(actions).toBe(0);
    finish();
    await operation;
    expect(actions).toBe(1);
  });
  it('동시 요청도 순서대로 append 정착 후 성공하고 닫힌 원장을 다시 쓰지 않는다', async () => {
    const rows: string[] = [];
    const journal = nativeJournal('/private/not-accessed', async (_path, value) => {
      rows.push(String(value));
    });
    await Promise.all([journal.sink(event), journal.sink({ ...event, sequence: 2 })]);
    await journal.close();
    expect(journal.healthy()).toBe(true);
    expect(rows.map((row) => JSON.parse(row).sequence)).toEqual([1, 2]);
    expect(rows.join('')).not.toMatch(/cookie|email|password|body|userId/);
    await expect(journal.sink(event)).rejects.toThrow('LOAD_JOURNAL_UNAVAILABLE');
  });
  it('쓰기 실패는 고정 오류로 바꾸고 이후 성공이나 close로 복구했다고 하지 않는다', async () => {
    const journal = nativeJournal('/private/not-accessed', async () => {
      throw new Error('private-canary');
    });
    await expect(journal.sink(event)).rejects.toThrow(/^LOAD_JOURNAL_FAILED$/);
    await expect(journal.close()).rejects.toThrow('LOAD_JOURNAL_NOT_CLOSED');
    expect(journal.healthy()).toBe(false);
  });
  it('타입 구조상 허용될 수 있는 추가 개인정보 필드도 저장 전에 거부한다', async () => {
    let writes = 0;
    const journal = nativeJournal('/private/not-accessed', async () => {
      writes++;
    });
    const extra = { ...event, cookie: 'private-canary' };
    await expect(journal.sink(extra)).rejects.toThrow(/^LOAD_JOURNAL_EVENT_INVALID$/);
    expect(writes).toBe(0);
    expect(journal.healthy()).toBe(false);
  });
  it('늦은 write는 무효 상태를 영구 유지하며 실제 정착 전 close를 주장하지 않는다', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const delayed = new Promise<void>((done) => {
      finish = done;
    });
    const journal = nativeJournal('/private/not-accessed', async () => delayed);
    try {
      const failure = expect(journal.sink(event)).rejects.toThrow('LOAD_JOURNAL_FAILED');
      await vi.advanceTimersByTimeAsync(2001);
      await failure;
      expect(journal.healthy()).toBe(false);
      finish();
      await Promise.resolve();
      await expect(journal.close()).rejects.toThrow();
    } finally {
      finish();
      vi.useRealTimers();
    }
  });
});
