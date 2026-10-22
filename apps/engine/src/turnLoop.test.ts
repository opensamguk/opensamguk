import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import { TurnLoop, ENGINE_BATCH_STEPS, ENGINE_BATCH_MS } from './turnLoop';
import type { Lease } from './lease';

function fixture(total: number, elapsedNow = () => 0) {
  const loop = new TurnLoop({} as PrismaClient, {} as Lease, { elapsedNow });
  let count = 0;
  Reflect.set(loop, 'step', async () => {
    const progressed = count < total;
    if (progressed) count++;
    return {
      status: 'RUNNING',
      tick: count,
      state: null,
      checkpointed: false,
      progressed,
      execution: progressed ? { generalId: 1, tick: count, commandKey: 'rest' } : null,
    };
  });
  return loop;
}

describe('AC-M1-21 폴링 배치 메모리 경계', () => {
  it('1024 사건은 64개 이하 16개 배치로 나누고 마지막 확인은 more=false다', async () => {
    const loop = fixture(1024);
    let count = 0;
    for (let i = 0; i < 16; i++) {
      const batch = await loop.poll();
      expect(batch.more).toBe(true);
      expect(batch.executions).toHaveLength(ENGINE_BATCH_STEPS);
      count += batch.executions.length;
    }
    expect(count).toBe(1024);
    expect(await loop.poll()).toEqual({ executions: [], status: 'RUNNING', more: false });
    expect(loop.state).toBeNull();
  });
  it('250ms가 지난 첫 step 뒤 돌아오며 advanceTo는 상한 없이 전체를 반환한다', async () => {
    let elapsed = 0;
    const loop = fixture(1024, () => {
      elapsed += ENGINE_BATCH_MS;
      return elapsed;
    });
    expect((await loop.poll()).executions).toHaveLength(1);
    expect(await loop.advanceTo(5000)).toHaveLength(1023);
  });
});
