import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import {
  CRASH_LIMIT,
  CRASH_WINDOW_MS,
  engineChildArgs,
  recentCrashes,
  restartDelay,
  runSupervisor,
} from './supervisor';
import { fileURLToPath } from 'node:url';

it('T2-15 AC-M2-08 번들은 자기 파일을, 소스는 tsx index.ts를 다시 실행한다', () => {
  const bundle = new URL('./directory with spaces/engine.mjs', import.meta.url);
  expect(engineChildArgs(true, bundle.href, 'world-a')).toEqual([fileURLToPath(bundle), '--world', 'world-a']);
  const source = new URL('./supervisor.ts', import.meta.url);
  expect(engineChildArgs(false, source.href, 'world-b')).toEqual([
    '--import',
    'tsx',
    fileURLToPath(new URL('./index.ts', source)),
    '--world',
    'world-b',
  ]);
});

describe('감독 재시작 정책', () => {
  it('백오프는 1·2·4초로 늘고 60초에서 멈춘다', () => {
    expect(Array.from({ length: 9 }, (_, i) => restartDelay(i + 1))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it('5분 창의 경계 밖 크래시는 제외하고 5회를 임계로 삼는다', () => {
    expect(CRASH_LIMIT).toBe(5);
    expect(recentCrashes([0, 1, 1000, CRASH_WINDOW_MS], CRASH_WINDOW_MS)).toEqual([1, 1000, CRASH_WINDOW_MS]);
    expect(recentCrashes([0, 1, 1000], CRASH_WINDOW_MS + 1000)).toEqual([]);
  });
});

it('ENDED 발견은 kind와 관계없이 모든 PENDING을 대상으로 한다 (질의 단위)', async () => {
  const controller = new AbortController();
  const findMany = vi.fn(async () => {
    controller.abort();
    return [];
  });
  const spawnChild = vi.fn();
  await runSupervisor({ world: { findMany } } as unknown as PrismaClient, { signal: controller.signal, spawnChild });
  expect(findMany).toHaveBeenCalledExactlyOnceWith({
    where: {
      OR: [
        { status: { in: ['RUNNING', 'PAUSED'] } },
        {
          status: 'PREOPEN',
          inputEvents: {
            some: {
              status: 'PENDING',
              kind: {
                in: [
                  'admin.world.start',
                  'admin.world.pause',
                  'admin.world.resume',
                  'admin.world.setOption',
                  'general.possess',
                ],
              },
            },
          },
        },
        { status: 'ENDED', inputEvents: { some: { status: 'PENDING' } } },
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  expect(spawnChild).not.toHaveBeenCalled();
});
