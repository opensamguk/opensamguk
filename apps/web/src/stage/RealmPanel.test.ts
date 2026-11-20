import { describe, expect, it } from 'vitest';
import { realmRows } from './RealmPanel';

// INT-29 천하 형세 판: 세력마다 도시·큰 도시·장수 수와 수도를 세고, 도시가 많은 차례로 둔다.
describe('realmRows', () => {
  const nations = [
    { id: 1, name: '위', color: '#336699', capitalCityKey: 10 },
    { id: 2, name: '촉', color: '#22aa44', capitalCityKey: 20 },
    { id: 3, name: '망국', color: '#888888', capitalCityKey: null },
  ] as never[];
  const cities = [
    { key: 10, name: '허', nationId: 1, level: 8 },
    { key: 11, name: '진류', nationId: 1, level: 6 },
    { key: 20, name: '성도', nationId: 2, level: 8 },
    { key: 30, name: '공백', nationId: null, level: 5 },
  ];
  const generals = [{ nationId: 1 }, { nationId: 1 }, { nationId: 2 }, { nationId: null }];

  it('도시 없는 세력은 빼고 도시 수·큰 도시 수·장수 수·수도를 센다', () => {
    const rows = realmRows(nations, cities, generals);
    expect(rows.map((row) => row.nation.name)).toEqual(['위', '촉']);
    expect(rows[0]).toMatchObject({ cities: 2, bigCities: 1, generals: 2, capitalName: '허' });
    expect(rows[1]).toMatchObject({ cities: 1, bigCities: 1, generals: 1, capitalName: '성도' });
  });
});
