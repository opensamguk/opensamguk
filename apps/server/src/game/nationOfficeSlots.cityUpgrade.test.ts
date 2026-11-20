import { expect, it } from 'vitest';
import { parseOfficeTurn } from './nationOfficeSlots';

const world = { preset: null, replayFormat: 3 } as Parameters<typeof parseOfficeTurn>[0];
it.each(['nation_expand', 'nation_shrink'])(
  'AC-INT-30 국가 예턴 접수: %s의 직책과 도시 인자를 검사한다',
  (commandKey) => {
    for (const level of [5, 6, 7, 8, 9, 10, 11, 12])
      expect(parseOfficeTurn(world, level, { commandKey, args: { cityKey: 10 } })).toEqual({
        commandKey,
        args: { cityKey: 10 },
      });
    for (const level of [0, 1, 4, 13, 5.5])
      expect(() => parseOfficeTurn(world, level, { commandKey, args: { cityKey: 10 } })).toThrow(
        '명령과 인자를 확인하세요.',
      );
    for (const args of [{}, { cityKey: '10' }, { cityKey: 0 }, { cityKey: 10, nationId: 2 }])
      expect(() => parseOfficeTurn(world, 12, { commandKey, args })).toThrow('명령과 인자를 확인하세요.');
    expect(() => parseOfficeTurn(world, 12, { commandKey: 'upgrade_city', args: { cityKey: 10 } })).toThrow();
  },
);
