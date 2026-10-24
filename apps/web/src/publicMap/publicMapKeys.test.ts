import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { toPublicMaps, type PublicMaps } from './publicMaps';

// T2-25 · AC-M2-20 후속. 서버 공개 계약(T2-24)은 도시 key와 links를 문자열로 낸다.
// 화면은 그 응답을 기존 숫자 키 지도에 맞춰 받아야 한다. 기대값은 구현 함수로 만들지 않고 직접 적는다.
type PublicMapsOutput = inferRouterOutputs<AppRouter>['world']['publicMaps'];

const takenAt = '2026-10-23T05:10:00.000Z';
const luoyang = { key: '1', name: '낙양', level: 8, x: 120, y: 80, nationId: 1, links: ['2'] };
const changan = { key: '2', name: '장안', level: 8, x: 60, y: 70, nationId: 2, links: ['1'] };
const wei = { id: 1, name: '위', color: '#000080' };
const shu = { id: 2, name: '촉', color: '#008000' };

const serverResponse = {
  delayMinutes: 10,
  worlds: [
    {
      id: 'w1',
      name: '첫 천하',
      status: 'RUNNING',
      map: { takenAt, year: 190, month: 3, cities: [luoyang, changan], nations: [wei, shu] },
    },
  ],
} satisfies PublicMapsOutput;

const expected: PublicMaps = {
  delayMinutes: 10,
  worlds: [
    {
      id: 'w1',
      name: '첫 천하',
      status: 'RUNNING',
      map: {
        takenAt: '2026-10-23T05:10:00.000Z',
        year: 190,
        month: 3,
        cities: [
          { key: 1, name: '낙양', level: 8, x: 120, y: 80, nationId: 1, links: [2] },
          { key: 2, name: '장안', level: 8, x: 60, y: 70, nationId: 2, links: [1] },
        ],
        nations: [
          { id: 1, name: '위', color: '#000080' },
          { id: 2, name: '촉', color: '#008000' },
        ],
      },
    },
  ],
};

describe('서버 문자열 도시 키', () => {
  it('문자열 key·links 도시를 버리지 않고 숫자 키 지도로 받는다', () => {
    const result = toPublicMaps(serverResponse);
    expect(result.worlds[0]?.map?.cities).toHaveLength(2);
    expect(result).toEqual(expected);
  });

  it('문자열 key 응답에 섞인 보급·장수·병력 값은 결과에 남지 않는다', () => {
    const leaked = {
      delayMinutes: 10,
      secret: 'x',
      worlds: [
        {
          id: 'w1',
          name: '첫 천하',
          status: 'RUNNING',
          ownerId: 'u1',
          map: {
            takenAt,
            year: 190,
            month: 3,
            tick: 5,
            cities: [
              { ...luoyang, supplied: false, troops: 5000, generals: [{ name: '조조' }] },
              { ...changan, supplied: true, population: 1 },
            ],
            nations: [{ ...wei, gold: 9999, rice: 9999 }, shu],
            generals: [{ id: 1, name: '조조', crew: 5000 }],
          },
        },
      ],
    };
    const result = toPublicMaps(leaked);
    expect(result.worlds[0]?.map?.cities).toHaveLength(2);
    expect(result).toEqual(expected);
  });

  it('이상하거나 겹치는 키, 알 수 없는 국가의 도시는 다른 키나 색으로 바꾸지 않고 버린다', () => {
    const city = (key: unknown, nationId: unknown, links: unknown) => ({
      key,
      name: `도시${String(key)}`,
      level: 5,
      x: 10,
      y: 20,
      nationId,
      links,
    });
    const map = (cities: unknown, nations: unknown) =>
      toPublicMaps({
        delayMinutes: 10,
        worlds: [
          { id: 'w1', name: '첫 천하', status: 'RUNNING', map: { takenAt, year: 190, month: 3, cities, nations } },
        ],
      }).worlds[0]?.map;

    const result = map(
      [
        city('1', 1, ['2', '', '01', '1.0', '-1', '1e3', '9007199254740993', 2, '1', '2', '7']),
        city('2', null, ['1']),
        city('9007199254740991', null, []),
        city('', 1, []),
        city('01', 1, []),
        city('1.0', 1, []),
        city('-1', 1, []),
        city('1e3', 1, []),
        city(' 4', 1, []),
        city('9007199254740993', 1, []),
        city(3, 1, []),
        city('5', 1, []),
        city('5', null, []),
        city('6', 9, []),
        city('7', 3, ['1']),
        city('8', '1', []),
        city('9', 1, '1'),
      ],
      [
        { id: 1, name: '위', color: '#000080' },
        { id: 3, name: '색 없는 나라', color: 'red' },
        { id: 4, name: '겹친 나라', color: '#111111' },
        { id: 4, name: '겹친 나라 둘', color: '#222222' },
      ],
    );
    expect(result?.cities).toEqual([
      { key: 1, name: '도시1', level: 5, x: 10, y: 20, nationId: 1, links: [2] },
      { key: 2, name: '도시2', level: 5, x: 10, y: 20, nationId: null, links: [1] },
      { key: 9007199254740991, name: '도시9007199254740991', level: 5, x: 10, y: 20, nationId: null, links: [] },
    ]);
    expect(result?.nations).toEqual([{ id: 1, name: '위', color: '#000080' }]);

    expect(map('broken', [])).toBeNull();
    expect(map([], 'broken')).toBeNull();
  });
});
