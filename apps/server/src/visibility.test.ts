import { beforeAll, describe, expect, it } from 'vitest';
import { readFixture } from '../test/readFixture';
import {
  cityInfo,
  generalInfo,
  mapCity,
  nationInfo,
  nationRecordInfo,
  visibility,
  worldRecordInfo,
} from './visibility';

let state: Awaited<ReturnType<typeof readFixture>>;
beforeAll(async () => {
  state = await readFixture();
});

describe('T1-12 / AC-M1-19 공개 범위 표', () => {
  it.each([
    { viewer: 0, cities: [true, false, false], nations: [true, false], generals: [true, true, false, false] },
    { viewer: 2, cities: [true, true, false], nations: [false, true], generals: [false, false, true, false] },
    { viewer: 3, cities: [true, false, false], nations: [false, false], generals: [false, false, false, true] },
    { viewer: null, cities: [false, false, false], nations: [false, false], generals: [false, false, false, false] },
  ])('아군·적·재야·미생성 viewer=$viewer', ({ viewer, cities, nations, generals }) => {
    const actor = viewer === null ? null : state.generals[viewer]!;
    const policy = visibility(actor);
    expect(state.cities.slice(0, 3).map(policy.city)).toEqual(cities);
    expect(state.nations.map(policy.nation)).toEqual(nations);
    expect(state.generals.map(policy.general)).toEqual(generals);
  });

  it('허용하지 않은 필드는 값이 아니라 키 자체가 없고 재야끼리는 공유하지 않는다', () => {
    const actor = state.generals[3]!;
    const otherWild = { ...state.generals[0]!, nationId: null, worldId: 'world', turnRevision: 0 };
    expect(generalInfo(otherWild, actor)).toEqual({ id: otherWild.id, name: otherWild.name, nationId: null });
    const city = { ...state.cities[1]!, worldId: 'world' };
    expect(cityInfo(city, actor)).toEqual(mapCity(city));
    const nation = { ...state.nations[0]!, worldId: 'world' };
    expect(nationInfo(nation, { cityCount: 1, generalCount: 2 }, actor)).toEqual({
      id: 1,
      name: nation.name,
      color: nation.color,
      cityCount: 1,
      generalCount: 2,
    });
  });

  it('상세 장수도 계정 식별자·상성·월드·추가 저장 필드를 반환하지 않는다', () => {
    const source = {
      ...state.generals[0]!,
      worldId: 'secret-world',
      userId: 'secret-user',
      affinity: 77,
      turnRevision: 3,
      passwordHash: 'secret-hash',
    };
    const result = generalInfo(source, source);
    expect(result).toMatchObject({ gold: 11001, rice: 12001, crew: 13001, train: 41, atmos: 51 });
    for (const field of ['worldId', 'userId', 'affinity', 'turnRevision', 'passwordHash'])
      expect(result).not.toHaveProperty(field);
  });

  it('공개 연감 JSON에서 국고·군량·추정 가능한 국력과 중첩 비밀값을 버린다', () => {
    const data = {
      nations: [
        { nationId: 1, cities: 3, generals: 4, gold: 100, rice: 200, power: 987654, nested: { token: 'secret' } },
      ],
      cities: [{ cityKey: 1, nationId: 1, population: 999, token: 'secret' }],
      stateHash: 'secret',
    };
    expect(worldRecordInfo(data)).toEqual({
      nations: [{ nationId: 1, cities: 3, generals: 4 }],
      cities: [{ cityKey: 1, nationId: 1 }],
    });
    expect(nationRecordInfo(data.nations[0]!)).toEqual({ nationId: 1, cities: 3, generals: 4, gold: 100, rice: 200 });
  });
});
