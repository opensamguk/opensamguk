import { expect, it } from 'vitest';
import { worldResolver } from './resolver';
import { assertEnabledSlots, parseSlot } from './slots';

it('AC-INT-28 API 명령 목록과 개인 칸은 상시 제공 교역을 쓴다', () => {
  const world = { preset: null, replayFormat: 3 };
  expect(worldResolver(world).resolver.get('trade')).toMatchObject({ key: 'trade', target: 'general' });
  const turn = parseSlot({ commandKey: 'trade', args: { cityKey: 2 } }, true);
  expect(() => assertEnabledSlots(world, [turn])).not.toThrow();
  expect(() => assertEnabledSlots({ ...world }, [turn])).not.toThrow();
  expect(() => assertEnabledSlots({ ...world, replayFormat: 1 }, [turn])).toThrow('명령과 인자');
});
