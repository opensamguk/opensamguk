// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EquipmentStatus, equipmentEffectText } from './EquipmentStatus';
import type { EquipmentBoard } from './useEquipment';

afterEach(cleanup);

// 장착 장비 칸 (p3-generals-20). 손으로 만든 equipment.mine 값이고 서버 실행의 증거가 아니다.
type Item = EquipmentBoard['items'][number];
const item = (patch: Partial<Item>): Item => ({
  key: 'weapon_01',
  name: '단도',
  slot: 'weapon',
  grade: 1,
  cost: 1000,
  requiredSecurity: 0,
  stat: 'strength',
  bonus: 1,
  goods: { iron: 5, wood: 0, horses: 0 },
  failure: null,
  ...patch,
});
const board = (patch: Partial<EquipmentBoard>): EquipmentBoard =>
  ({
    generalId: 1,
    slots: {},
    baseStats: { leadership: 70, strength: 100, intel: 50, politics: 50, charm: 50 },
    stats: { leadership: 70, strength: 100, intel: 50, politics: 50, charm: 50 },
    bonus: { leadership: 0, strength: 0, intel: 0 },
    sellRateBp: 5000,
    tradeExperience: 10,
    items: [],
    sales: [],
    ...patch,
  }) as EquipmentBoard;

describe('장착 장비 칸', () => {
  it('장착한 장비 이름 옆에 카탈로그의 효과(능력치 +N)를 적고, 빈 칸은 미장착이다', () => {
    const data = board({
      slots: { weapon: 'weapon_01', book: 'book_03' },
      items: [item({}), item({ key: 'book_03', name: '손자병법', slot: 'book', grade: 3, stat: 'intel', bonus: 3 })],
    });
    render(<EquipmentStatus read={{ kind: 'ready', data }} />);
    const region = screen.getByRole('region', { name: '장착 장비' });
    expect(within(region).getByText('단도', { exact: true })).toBeTruthy();
    expect(
      within(region)
        .getAllByTestId('equipment-effect')
        .map((node) => node.textContent),
    ).toEqual(['(무력 +1)', '(지력 +3)']);
    expect(within(region).getByText('미장착', { exact: true })).toBeTruthy();
    expect(equipmentEffectText({ stat: 'leadership', bonus: 3 })).toBe('통솔 +3');
  });
});
