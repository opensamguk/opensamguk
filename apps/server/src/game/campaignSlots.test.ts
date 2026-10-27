import { expect, it } from 'vitest';
import { assertEnabledSlots, parseSlot } from './slots';
import { worldResolver } from './resolver';

const world = {
  preset: null,
  replayFormat: 3,
  ruleFeatures: ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'],
};
const resolver = worldResolver(world).resolver;

it.each(['recruit', 'conscript', 'train', 'morale', 'dismiss'])(
  '부곡 %s 예약은 선택한 월드의 unitId 계약을 쓴다',
  (key) => {
    const args = key === 'recruit' || key === 'conscript' ? { amount: 10, crewType: 1100, unitId: 2 } : { unitId: 2 };
    expect(parseSlot({ commandKey: key, args }, true, resolver)).toEqual({ commandKey: key, args, explicit: true });
    expect(() => parseSlot({ commandKey: key, args }, true)).toThrow('명령과 인자');
    expect(() => parseSlot({ commandKey: key, args: { ...args, unitId: 0 } }, true, resolver)).toThrow('명령과 인자');
    expect(() => parseSlot({ commandKey: key, args: { ...args, ownerId: 99 } }, true, resolver)).toThrow('명령과 인자');
  },
);

it('부곡 입력을 허용해도 그 월드에서 꺼진 명령을 등록하지 않는다', () => {
  const disabled = parseSlot({ commandKey: 'fire_attack', args: { cityKey: 2 } }, true, resolver);
  expect(() => assertEnabledSlots(world, [disabled])).toThrow('명령과 인자');
  expect(parseSlot(null, true, resolver)).toMatchObject({ commandKey: 'rest', args: {}, explicit: false });
});
