import { describe, expect, it } from 'vitest';
import {
  amountLimit,
  amountPresets,
  cityDistances,
  cityLabel,
  countText,
  displayName,
  groupByDistance,
  matchesName,
  nationFactsText,
  OWN_CITY_FIRST,
  purseLine,
  recruitRoom,
  relationLabel,
  RESOURCE_ORDER,
  sortGenerals,
  statLine,
  troopLine,
} from './targets';

describe('INT-25 인자 입력 대상 계산', () => {
  const cities = [
    { key: 1, name: '허창', level: 8, nationId: 1, links: [2, 3] },
    { key: 2, name: '진류', level: 6, nationId: 2, links: [1, 4] },
    { key: 3, name: '진', level: 6, nationId: 1, links: [1] },
    { key: 4, name: '복양', level: 6, nationId: 3, links: [2] },
    { key: 5, name: '고립', level: 1, nationId: null, links: [] },
  ];

  it('연결선을 따라 칸 수를 센다', () => {
    const d = cityDistances(cities, 1);
    expect(Object.fromEntries(d)).toEqual({ 1: 0, 2: 1, 3: 1, 4: 2 });
    expect(cityDistances(cities, null).size).toBe(0);
  });

  it('거리별로 묶고 같은 거리에서는 다른 국가 도시를 먼저 둔다', () => {
    const groups = groupByDistance(
      cities.filter((city) => city.key !== 1),
      cityDistances(cities, 1),
      1,
    );
    expect(groups.map((g) => [g.distance, g.items.map((c) => c.name)])).toEqual([
      [1, ['진류', '진']],
      [2, ['복양']],
      [null, ['고립']],
    ]);
  });

  it('발령·천도·백성동원은 같은 거리에서 내 국가 도시를 먼저 둔다', () => {
    const groups = groupByDistance(
      cities.filter((city) => city.key !== 1),
      cityDistances(cities, 1),
      1,
      true,
    );
    expect(groups[0]!.items.map((c) => c.name)).toEqual(['진', '진류']);
    expect(OWN_CITY_FIRST.has('nation_assign')).toBe(true);
    expect(OWN_CITY_FIRST.has('move')).toBe(false);
  });

  it('도시 이름표는 `도시명 (국가명)`이고 주인이 없으면 공백지다', () => {
    expect(cityLabel('허창', '위')).toBe('허창 (위)');
    expect(cityLabel('고립', null)).toBe('고립 (공백지)');
  });

  it('이름 일부나 초성으로 찾고 찾은 수를 적는다', () => {
    expect(matchesName('조조', '조')).toBe(true);
    expect(matchesName('조조', 'ㅈㅈ')).toBe(true);
    expect(matchesName('관우', 'ㅈ')).toBe(false);
    expect(matchesName('관우', '')).toBe(true);
    expect(countText(3, 10, 'ㅈ')).toBe('3개 / 10개');
    expect(countText(10, 10, ' ')).toBe('10개');
  });

  it('국가 카드는 수도·국력·도시·장수를 한 줄로 적고 모르는 값은 뺀다', () => {
    expect(nationFactsText({ capital: '허창', power: 12345, cities: 8, generals: 21 })).toBe(
      '수도 허창 · 국력 12,345 · 도시 8 · 장수 21',
    );
    expect(nationFactsText({ capital: null, cities: 0 })).toBe('수도 없음 · 도시 0');
  });

  it('관계는 끝나는 달까지 남은 달을 센다', () => {
    expect(relationLabel('DECLARED', { year: 191, month: 3 }, { year: 190, month: 3 })).toBe('선포 · 12개월 남음');
    expect(relationLabel('NON_AGGRESSION', { year: 190, month: 3 }, { year: 190, month: 3 })).toBe(
      '불가침 · 이번 달까지',
    );
    expect(relationLabel('NON_AGGRESSION', { year: 191, month: 1 }, null)).toBe('불가침 · 191년 1월까지');
    expect(relationLabel('WAR', null, { year: 190, month: 1 })).toBe('교전');
  });

  it('장수 카드 줄은 받은 수치로만 만든다', () => {
    const g = { id: 1, name: '조조', leadership: 90, strength: 72, intel: 91, crew: 3000, train: 80, atmos: 70 };
    expect(statLine(g)).toBe('통솔 90 · 무력 72 · 지력 91');
    expect(troopLine(g)).toBe('병력 3,000 · 훈련 80 · 사기 70');
    expect(purseLine(g)).toBeNull();
    expect(purseLine({ ...g, gold: 1200, rice: 800 })).toBe('금 1,200 · 쌀 800');
    expect(statLine({ id: 2, name: '적장' })).toBeNull();
  });

  it('포상은 물자가 적은 장수부터, 몰수는 많은 장수부터, 그 밖은 유저 장수부터 이름순이다', () => {
    const list = [
      { id: 1, name: '하후돈', gold: 500, isHuman: false },
      { id: 2, name: '조인', gold: 100, isHuman: true },
      { id: 3, name: '가후', gold: 900, isHuman: false },
      { id: 4, name: '모름' },
    ];
    const names = (rows: typeof list) => rows.map((g) => g.name);
    expect(
      names(sortGenerals(list, { resource: 'gold', direction: RESOURCE_ORDER.nation_reward! }, (g) => g.name)),
    ).toEqual(['조인', '하후돈', '가후', '모름']);
    expect(
      names(sortGenerals(list, { resource: 'gold', direction: RESOURCE_ORDER.nation_seize! }, (g) => g.name)),
    ).toEqual(['가후', '하후돈', '조인', '모름']);
    expect(names(sortGenerals(list, null, (g) => g.name))).toEqual(['모름', '조인', '가후', '하후돈']);
  });

  it('모병 수량 단추는 통솔×100에서 지금 병력을 뺀 자리로 센다', () => {
    expect(recruitRoom(75, 3000)).toEqual({ cap: 7500, room: 4500, half: 2200 });
    expect(recruitRoom(50, 6000)).toEqual({ cap: 5000, room: 0, half: 0 });
    expect(amountPresets(1, 3000)).toEqual([100, 500, 1000]);
    expect(amountPresets(1000, 2_147_483_647)).toEqual([1000, 5000, 10000]);
  });

  it('수량 `전부`는 물자를 내는 쪽이 가진 만큼이다', () => {
    const purses = {
      wallet: { gold: 300, rice: 700 },
      treasury: { gold: 50000, rice: 20000 },
      target: { gold: 900, rice: undefined },
    };
    expect(amountLimit('donate', { resource: 'rice' }, purses)).toBe(700);
    expect(amountLimit('trade_rice', { buy: 'true' }, purses)).toBe(300);
    expect(amountLimit('trade_rice', { buy: 'false' }, purses)).toBe(700);
    expect(amountLimit('nation_reward', { resource: 'gold' }, purses)).toBe(50000);
    expect(amountLimit('nation_aid', { resource: 'rice' }, purses)).toBe(20000);
    expect(amountLimit('nation_seize', { resource: 'gold' }, purses)).toBe(900);
    expect(amountLimit('nation_seize', { resource: 'rice' }, purses)).toBeNull();
    expect(amountLimit('donate', {}, purses)).toBeNull();
    expect(amountLimit('recruit', { resource: 'gold' }, purses)).toBeNull();
  });

  it('장수 이름의 괄호와 그 안을 뺀다', () => {
    expect(displayName('조조(曹操)')).toBe('조조');
    expect(displayName('유도(145년생)')).toBe('유도');
    expect(displayName('관우')).toBe('관우');
    expect(displayName('(무명)')).toBe('(무명)');
  });
});
