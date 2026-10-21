import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { cloneWorld } from './clone';

it('빠른 월드 복제는 structuredClone과 같고 중첩 필드도 분리한다', () => {
  const world = commandWorld();
  world.commandMeta = { nextNationId: 3, offers: { 4: 1 } };
  world.nationTurns = { 1: [{ commandKey: 'nation_rest', args: { nested: [1] } }] };
  const before = structuredClone(world);
  const clone = cloneWorld(world);
  expect(clone).toEqual(before);
  clone.generals[1]!.gold++;
  clone.nations[1]!.gold++;
  clone.cities[1]!.connections.push(4);
  clone.diplomacies[0]!.state = 'DECLARED';
  clone.commandMeta!.offers[4] = 2;
  (clone.nationTurns![1]![0]!.args as { nested: number[] }).nested.push(2);
  expect(world).toEqual(before);
});
