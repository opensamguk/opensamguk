import { expect, it, vi } from 'vitest';
import { buildServer } from './server';
import { publicMapInfo } from './visibility';
import type { PrismaClient } from '@opensamguk/db';

it('공개 지도 사본은 허용 필드만 남기고 깨진 JSON은 거부한다', () => {
  expect(
    publicMapInfo({
      cities: [{ key: '1', name: '성', level: 1, x: 2, y: 3, nationId: 1, links: ['2'], supplied: true, crew: 123 }],
      nations: [{ id: 1, name: '국', color: '#ffffff', gold: 123 }],
      generals: [{ userId: 'secret' }],
    }),
  ).toEqual({
    cities: [{ key: '1', name: '성', level: 1, x: 2, y: 3, nationId: 1, links: ['2'], supplied: true }],
    nations: [{ id: 1, name: '국', color: '#ffffff' }],
  });
  for (const data of [null, {}, { cities: [], nations: 'secret' }, { cities: [{ supplied: true }], nations: [] }])
    expect(publicMapInfo(data)).toBeNull();
});

it('AC-INT-28 공개 지도는 영지 칸의 도시 키와 점령된 전장 소유를 분리해 전달한다', () => {
  const territory = { tile: 8, originX: 0, originY: 0, columns: 2, rows: 1, owner: [1, -1] };
  const siteOwnership = [{ anchorKey: 2, nationId: 1 }];
  const snapshot = {
    cities: [],
    nations: [{ id: 1, name: '국', color: '#ffffff' }],
    siteOwnership,
    operationalMap: {
      id: 'public-map',
      version: 3,
      canvas: { width: 20, height: 20 },
      basemap: {
        source: 'natural-earth-5.1.2',
        projection: 'WGS84 plate carree',
        sha256: 'a'.repeat(64),
        bounds: [0, 0, 1, 1],
      },
      sites: [
        { id: 'city:a', name: '도시', kind: 'CITY', anchorKey: 1, position: { x: 5, y: 5 } },
        { id: 'field:b', name: '전장', kind: 'FIELD', anchorKey: 2, position: { x: 10, y: 10 } },
      ],
      routes: [],
      territory,
    },
  };
  expect(publicMapInfo(snapshot)).toMatchObject({ operationalMap: { territory }, siteOwnership });
  expect(
    publicMapInfo({
      ...snapshot,
      operationalMap: { ...snapshot.operationalMap, territory: { ...territory, owner: [1, 2] } },
    }),
  ).toBeNull();
});

it('서버는 잘못된 공개 지도 설정이면 DB를 읽기 전에 시작을 거부한다', async () => {
  vi.stubEnv('PUBLIC_MAP_DELAY_MINUTES', '4');
  vi.stubEnv('PUBLIC_MAP_INTERVAL_MINUTES', '5');
  try {
    await expect(buildServer({ db: {} as PrismaClient, logging: false })).rejects.toThrow('간격');
  } finally {
    vi.unstubAllEnvs();
  }
});
