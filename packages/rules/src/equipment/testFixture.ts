import type { EquipmentConfig } from './config';
import type { LogisticsConfig } from '../logistics/state';

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
export const TEST_EQUIPMENT_LOGISTICS_CONFIG: LogisticsConfig = {
  version: 1,
  specialties: [],
  capacity: { base: 1000, perLevel: 1000, maxLevel: 2 },
  upgrade: { gold: 1, wood: 1 },
  transport: { maxHops: 8, hopsPerMonth: 2, lossBpPerHop: 100, maxPerOrder: 100, maxActivePerNation: 2 },
  recruitPer100: {
    '1': { iron: 2, wood: 0, horses: 0 },
    '2': { iron: 0, wood: 3, horses: 0 },
    '3': { iron: 1, wood: 0, horses: 1 },
  },
  build: { wall: { iron: 0, wood: 4, horses: 0 }, defence: { iron: 2, wood: 3, horses: 0 } },
  trade: { iron: { buy: 3, sell: 1 }, wood: { buy: 3, sell: 1 }, horses: { buy: 3, sell: 1 } },
};
