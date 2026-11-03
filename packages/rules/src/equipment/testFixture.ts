import type { EquipmentConfig } from './config';

// 인공 시험값이다. 원작 수치·공개 프로필에서 읽지 않는다.
export const TEST_EQUIPMENT_CONFIG: EquipmentConfig = {
  version: 1,
  items: [
    {
      key: 'horse_01',
      name: '시험명마1',
      slot: 'horse',
      grade: 1,
      cost: 11,
      requiredSecurity: 7,
      stat: 'leadership',
      bonus: 1,
      goods: { iron: 0, wood: 0, horses: 2 },
    },
    {
      key: 'weapon_01',
      name: '시험무기1',
      slot: 'weapon',
      grade: 1,
      cost: 13,
      requiredSecurity: 9,
      stat: 'strength',
      bonus: 2,
      goods: { iron: 3, wood: 0, horses: 0 },
    },
    {
      key: 'book_01',
      name: '시험서적1',
      slot: 'book',
      grade: 1,
      cost: 17,
      requiredSecurity: 4,
      stat: 'intel',
      bonus: 3,
      goods: { iron: 0, wood: 0, horses: 0 },
    },
  ],
  sellRateBp: 4000,
  tradeExperience: 2,
};
