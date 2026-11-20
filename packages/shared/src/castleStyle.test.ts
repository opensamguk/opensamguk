import { describe, expect, it } from 'vitest';
import { castleStyle, CASTLE_STYLES, EAST_SPRITES, REGION_GROUPS, TRIBE_SPRITES } from './castleStyle';

describe('AC-INT-29 거점 양식', () => {
  it('22양식과 모든 지역·이름을 판정한다', () => {
    expect(CASTLE_STYLES).toHaveLength(22);
    for (const [name, style] of [...Object.entries(TRIBE_SPRITES), ...EAST_SPRITES])
      expect(castleStyle({ name, region: 1 })).toBe(style);
    for (const [region, style] of Object.entries(REGION_GROUPS))
      expect(castleStyle({ name: '알 수 없는 이름', region: Number(region) })).toBe(style);
  });
  it('이름은 지역 번호에 우선하고 모르는 값은 중원이다', () => {
    expect(castleStyle({ name: '흉노', region: 9 })).toBe('tribe-xiongnu');
    expect(castleStyle({ name: '국내성', region: 11 })).toBe('east-goguryeo');
    for (const region of [15, 16, 999]) expect(castleStyle({ region })).toBe('central');
    expect(castleStyle()).toBe('central');
  });
});
