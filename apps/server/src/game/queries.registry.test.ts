import { expect, it } from 'vitest';
import { requestWorldCreateInput } from '@opensamguk/rules';
import { worldResolver } from './resolver';
it('AC-INT-28 선택 목록 없이 명령을 제공하고 기능 선택 입력을 거부한다', () => {
  const { resolver } = worldResolver({ preset: null, replayFormat: 3 });
  for (const key of ['spy', 'trade', 'nation_research_greatsword']) expect(resolver.get(key)).toBeDefined();
  const input = {
    expectedUserId: '10000000-0000-4000-8000-000000000001',
    idempotencyKey: '10000000-0000-4000-8000-000000000002',
    name: '전체 규칙',
    presetKey: 'regular',
    endYear: null,
  };
  expect(requestWorldCreateInput.safeParse({ ...input, fogOfWar: true }).success).toBe(true);
  expect(requestWorldCreateInput.safeParse({ ...input, ruleFeatures: [] }).success).toBe(false);
});
