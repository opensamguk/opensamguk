import { expect, it } from 'vitest';
import type { PrismaClient } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { applySexLedger } from '@opensamguk/rules';
import { loadSexLedger, readInitialResources, resolveWorldResourceSelection } from './resources';
it('AC-P2-27 2판 선택은 기본 칸을 채운 정규 키로 해석한다', () => {
  expect(resolveWorldResourceSelection({ map: 'san10@2', scenario: 'san10-191@2' }, { generalStats: [] })).toEqual({
    map: 'san10@2',
    scenario: 'san10-191@2',
    unitSet: 'basic',
    statRules: 'five-stats',
    portraitMap: '191-map',
  });
});

it.each([undefined, [], null])(
  'AC-INT-28 능력치 기본 판은 시나리오 자료 %j로 고르고 명시값은 보존한다',
  async (generalStats) => {
    const content = generalStats === undefined ? { id: 'custom' } : { id: 'custom', generalStats };
    const calls: string[][] = [];
    const db = {
      gameResource: {
        findMany: async ({ where }: { where: { OR: Array<{ kind: string; name: string; version: number }> } }) => {
          calls.push(where.OR.map((ref) => `${ref.kind}/${ref.name}`));
          return where.OR.map((ref) => {
            const value = ref.kind === 'SCENARIO' ? content : {};
            return { ...ref, content: value, contentHash: hashState(value), source: 'test' };
          });
        },
      },
    } as unknown as PrismaClient;
    const selection = { map: 'custom', scenario: 'custom' };
    const resources = await readInitialResources(db, selection);
    expect(calls[0]).toEqual(['SCENARIO/custom']);
    // 비어 있거나 잘못된 자료도 존재하면 5능력치 검사를 거쳐야 한다.
    expect(resources.statRules.name).toBe(generalStats === undefined ? 'default' : 'five-stats');
    expect((await readInitialResources(db, { ...selection, statRules: 'explicit@2' })).statRules).toMatchObject({
      name: 'explicit',
      version: 2,
    });
  },
);

it('AC-INT-28 적용할 성별 원장이 없으면 기본값을 쓰고 대상 원장의 불일치는 거부한다', () => {
  expect(loadSexLedger('no-ledger@2')).toBeUndefined();
  expect(applySexLedger({ scenarioKey: 'no-ledger@2', generals: [{ id: 1, name: '새 인물' }] })).toEqual([
    { id: 1, name: '새 인물', sex: 'UNKNOWN' },
  ]);
  expect(() =>
    applySexLedger({ scenarioKey: '1030', generals: [{ id: 1, name: '새 인물' }] }, loadSexLedger('1030')),
  ).toThrow('ID·이름');
  expect(
    applySexLedger({ scenarioKey: 'no-ledger', generals: [{ id: 1, name: '첫째', sex: 'FEMALE' as const }] }),
  ).toEqual([{ id: 1, name: '첫째', sex: 'FEMALE' }]);
  expect(() =>
    applySexLedger({
      scenarioKey: 'no-ledger',
      generals: [
        { id: 1, name: '첫째', sex: 'FEMALE' as const },
        { id: 2, name: '둘째' },
      ],
    }),
  ).toThrow('일부만');
});
