import { describe, expect, it, vi } from 'vitest';
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
  it.each(categories)('실행 사례와 겹친 %s 면제를 오래된 면제로 알린다', (category) => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const evidence = categories.map((entry) => ({ path: 'health', category: entry }));
    const report = compareAuthz(router, evidence, [{ path: 'health', category, reason: '옛 면제' }]);
    expect(report.missing).toEqual([`stale exemption: health ${category}`]);
    expect(report.exempted).toEqual([]);
  });
  it('경로 또는 종류가 다른 실행 사례는 정상 면제와 겹치지 않는다', () => {
    const router = t.router({
      health: t.procedure.query(() => true),
      nested: t.router({ health: t.procedure.mutation(() => true) }),
    });
    const evidence = Object.keys(router._def.procedures).flatMap((path) =>
      categories
        .filter((category) => path !== 'health' || category !== 'otherUser')
        .map((category) => ({ path, category })),
    );
    const report = compareAuthz(router, evidence, [{ path: 'health', category: 'otherUser', reason: '공개 확인' }]);
    expect(report).toEqual({
      procedures: [
        { path: 'health', type: 'query' },
        { path: 'nested.health', type: 'mutation' },
      ],
      missing: [],
      exempted: ['health otherUser: 공개 확인'],
    });
  });
  it.each([2, 3])('같은 면제 %i개는 중복 진단을 한 번 내고 정상 면제로 세지 않는다', (count) => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const evidence = categories
      .filter((category) => category !== 'otherUser')
      .map((category) => ({ path: 'health', category }));
    const exemptions = Array.from({ length: count }, (_, index) => ({
      path: 'health',
      category: 'otherUser' as const,
      reason: `사유 ${index}`,
    }));
    const report = compareAuthz(router, evidence, exemptions);
    expect(report.missing).toEqual(['duplicate exemption: health otherUser', 'health (query): otherUser']);
    expect(report.exempted).toEqual([]);
  });
  it('중복 면제가 실제 사례와도 겹치면 두 진단을 모두 낸다', () => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const evidence = categories.map((category) => ({ path: 'health', category }));
    const exemption = { path: 'health', category: 'otherUser' as const, reason: '공개 확인' };
    const report = compareAuthz(router, evidence, [exemption, exemption, exemption]);
    expect(report.missing).toEqual(['duplicate exemption: health otherUser', 'stale exemption: health otherUser']);
    expect(report.exempted).toEqual([]);
  });
  it('같은 종류의 정상 면제도 경로가 다르면 각각 센다', () => {
    const router = t.router({ one: t.procedure.query(() => true), two: t.procedure.query(() => true) });
    const evidence = ['one', 'two'].flatMap((path) =>
      categories.filter((category) => category !== 'otherUser').map((category) => ({ path, category })),
    );
    const report = compareAuthz(router, evidence, [
      { path: 'one', category: 'otherUser', reason: '첫 공개 조회' },
      { path: 'two', category: 'otherUser', reason: '둘째 공개 조회' },
    ]);
    expect(report.missing).toEqual([]);
    expect(report.exempted).toEqual(['one otherUser: 첫 공개 조회', 'two otherUser: 둘째 공개 조회']);
  });
  it('실행 사례 자체의 중복은 허용한다', () => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const evidence = categories.map((category) => ({ path: 'health', category }));
    const report = compareAuthz(router, [...evidence, ...evidence], []);
    expect(report.missing).toEqual([]);
    expect(report.exempted).toEqual([]);
  });
  it.each(['', ' \t\n '])('빈 사유 %j는 정상 면제로 세지 않는다', (reason) => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const report = compareAuthz(router, [], [{ path: 'health', category: 'success', reason }]);
    expect(report.missing).toEqual([
      'invalid exemption: health success',
      ...categories.map((category) => `health (query): ${category}`),
    ]);
    expect(report.exempted).toEqual([]);
  });
  it('삭제된 경로의 면제는 실행 기록이 있어도 거부한다', () => {
    const router = t.router({});
    const report = compareAuthz(
      router,
      [{ path: 'removed', category: 'success' }],
      [{ path: 'removed', category: 'success', reason: '옛 경로' }],
    );
    expect(report.missing).toContain('invalid exemption: removed success');
    expect(report.exempted).toEqual([]);
  });
  it('빈 사유가 섞인 중복 면제도 정상 면제로 세지 않는다', () => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const report = compareAuthz(
      router,
      [],
      [
        { path: 'health', category: 'otherUser', reason: '공개 확인' },
        { path: 'health', category: 'otherUser', reason: ' ' },
      ],
    );
    expect(report.missing).toContain('invalid exemption: health otherUser');
    expect(report.missing.filter((entry) => entry === 'duplicate exemption: health otherUser')).toHaveLength(1);
    expect(report.missing).toContain('health (query): otherUser');
    expect(report.exempted).toEqual([]);
  });
  it('CLI는 오래된 면제 진단을 MISSING으로 출력하고 종료 코드 1을 낸다', async () => {
    const router = t.router({ health: t.procedure.query(() => true) });
    const evidence = categories.map((category) => ({ path: 'health', category }));
    const spawn = vi.fn(() => ({ status: 0 }));
    const write = vi.fn();
    vi.doMock('node:child_process', () => ({ spawnSync: spawn }));
    vi.doMock('node:fs', () => ({
      mkdirSync: vi.fn(),
      readFileSync: () => JSON.stringify(evidence),
      writeFileSync: write,
    }));
    vi.doMock('../router', () => ({ appRouter: router }));
    vi.doMock('./case', () => ({ evidenceFile: '/diagnostic-only/cases.json' }));
    vi.doMock('./exemptions', () => ({ exemptions: [{ path: 'health', category: 'otherUser', reason: '옛 면제' }] }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('diagnostic exit');
    });
    try {
      vi.resetModules();
      await expect(import('../../../../tools/run-authz')).rejects.toThrow('diagnostic exit');
      expect(spawn).toHaveBeenCalledWith(
        'pnpm',
        ['test:int'],
        expect.objectContaining({ env: expect.objectContaining({ AUTHZ_RECORD: '1' }), stdio: 'inherit' }),
      );
      expect(write).toHaveBeenCalledWith('/diagnostic-only/cases.json', '[]');
      expect(error).toHaveBeenCalledWith('MISSING stale exemption: health otherUser');
      expect(log).toHaveBeenCalledWith('AUTHZ procedures=1 executed=5 exemptions=0 missing=1');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.doUnmock('node:child_process');
      vi.doUnmock('node:fs');
      vi.doUnmock('../router');
      vi.doUnmock('./case');
      vi.doUnmock('./exemptions');
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});
