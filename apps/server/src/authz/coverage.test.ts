import { describe, expect, it } from 'vitest';
import { initTRPC } from '@trpc/server';
import { categories, compareAuthz } from './coverage';
import { authzCase } from './case';

const t = initTRPC.create();
describe('T3-04 실제 절차 정의와 실행 사례 대조', () => {
  it('가짜 router에 경로 하나를 더하면 빠진 경로와 다섯 종류가 나온다', () => {
    const initial = t.router({ health: t.procedure.query(() => true) });
    const evidence = categories.map((category) => ({ path: 'health', category }));
    expect(compareAuthz(initial, evidence, []).missing).toEqual([]);
    const added = t.router({ health: t.procedure.query(() => true), uncovered: t.procedure.mutation(() => true) });
    expect(compareAuthz(added, evidence, []).missing).toEqual(
      categories.map((category) => `uncovered (mutation): ${category}`),
    );
  });
  it('미실행 사례는 세지 않고 면제 사유·존재하지 않는 경로를 검사한다', () => {
    const router = t.router({ health: t.procedure.query(() => true) });
    expect(compareAuthz(router, [], []).missing).toHaveLength(5);
    expect(compareAuthz(router, [], [{ path: 'health', category: 'success', reason: '공개 확인' }]).exempted).toEqual([
      'health success: 공개 확인',
    ]);
    expect(compareAuthz(router, [], [{ path: 'health', category: 'success', reason: '' }]).missing).toContain(
      'invalid exemption: health success',
    );
    expect(compareAuthz(router, [], [{ path: 'removed', category: 'success', reason: '옛 경로' }]).missing).toContain(
      'invalid exemption: removed success',
    );
  });
  it('도우미는 실제 콜백을 실행하고 실패를 전파한다', async () => {
    let called = false;
    await authzCase('health', 'success', async () => {
      called = true;
    })();
    expect(called).toBe(true);
    await expect(
      authzCase('health', 'success', async () => {
        throw new Error('실제 실패');
      })(),
    ).rejects.toThrow('실제 실패');
  });
});
