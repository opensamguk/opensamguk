import { expect, it } from 'vitest';
import { trade } from '@opensamguk/rules';
import { worldResolver } from './resolver';
import { assertEnabledSlots, parseSlot } from './slots';

it('API 명령 목록과 개인 칸은 같은 교역 feature 선택을 따른다', () => {
  const world = { preset: null, replayFormat: 3, ruleFeatures: ['treaty', 'treaty-trade'] };
  expect(worldResolver(world).resolver.get('trade')).toBe(trade);
  const turn = parseSlot({ commandKey: 'trade', args: { cityKey: 2 } }, true);
  expect(() => assertEnabledSlots(world, [turn])).not.toThrow();
  expect(() => assertEnabledSlots({ ...world, ruleFeatures: ['treaty'] }, [turn])).toThrow('명령과 인자');
  expect(() => assertEnabledSlots({ ...world, replayFormat: 1, ruleFeatures: [] }, [turn])).toThrow('명령과 인자');
});
