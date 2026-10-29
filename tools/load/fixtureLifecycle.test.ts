import { describe, expect, it } from 'vitest';
import { activateOwnedLoadWorld } from './fixtureLifecycle';

describe('L1 소유 등록과 취소 경계', () => {
  it('생성 await 중 취소되면 소유 등록 후 시계·엔진을 시작하지 않는다', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let complete!: (value: { worldId: string }) => void;
    const creation = new Promise<{ worldId: string }>((resolve) => {
      complete = resolve;
    });
    const work = activateOwnedLoadWorld(() => creation, {
      signal: controller.signal,
      onWorldCreated: () => {
        events.push('owned');
      },
      startClock: async () => {
        events.push('clock');
      },
      startEngine: async () => {
        events.push('engine');
      },
    });
    const rejected = expect(work).rejects.toThrow();
    controller.abort();
    complete({ worldId: 'owned' });
    await rejected;
    expect(events).toEqual(['owned']);
  });

  it('시계 시작 await 중 취소되면 새 엔진을 기동하지 않는다', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let finishClock!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finishClock = resolve;
    });
    let clockStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      clockStarted = resolve;
    });
    const work = activateOwnedLoadWorld(async () => ({ worldId: 'owned' }), {
      signal: controller.signal,
      onWorldCreated: () => {
        events.push('owned');
      },
      startClock: async () => {
        events.push('clock');
        clockStarted();
        await waiting;
      },
      startEngine: async () => {
        events.push('engine');
      },
    });
    const rejected = expect(work).rejects.toThrow();
    await started;
    controller.abort();
    finishClock();
    await rejected;
    expect(events).toEqual(['owned', 'clock']);
  });

  it('이미 취소됐으면 생성도 시작하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    let writes = 0;
    await expect(
      activateOwnedLoadWorld(
        async () => {
          writes++;
          return { worldId: 'unused' };
        },
        {
          signal: controller.signal,
          onWorldCreated: () => {
            writes++;
          },
          startClock: async () => {
            writes++;
          },
          startEngine: async () => {
            writes++;
          },
        },
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });
});
