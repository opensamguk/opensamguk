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
    cities: [{ key: '1', name: '성', level: 1, x: 2, y: 3, nationId: 1, links: ['2'] }],
    nations: [{ id: 1, name: '국', color: '#ffffff' }],
  });
  for (const data of [null, {}, { cities: [], nations: 'secret' }, { cities: [{ supplied: true }], nations: [] }])
    expect(publicMapInfo(data)).toBeNull();
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
