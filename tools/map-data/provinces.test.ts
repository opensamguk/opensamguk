import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { operationalMapSchema } from '../../packages/rules/src/world/map/operational';
import { applyProvinceRegions, type provinceTableSchema } from './provinces';
import type { z } from 'zod';

const map = operationalMapSchema.parse(
  JSON.parse(readFileSync(new URL('../../resources/map/san10.json', import.meta.url), 'utf8')),
);
const fixture = (): z.infer<typeof provinceTableSchema> => ({
  version: 1,
  regionScheme: 'province-191',
  sources: [{ id: 'fixture', title: '형식 검증용 출처', url: 'https://example.com/source' }],
  sites: map.sites.map((site, index) => ({
    siteId: site.id,
    name: site.name,
    region: (index % 16) + 1,
    source: 'fixture',
    method: 'regional-reference',
    quote: '형식 검증용 인용이며 사료 검수 증거가 아니다.',
  })),
});

it('AC-INT-22: 숭산은 潁川 陽城의 예주이고 경구는 呉郡의 양주다', () => {
  const table = JSON.parse(
    readFileSync(new URL('../../resources/map-drafts/san10/provinces.json', import.meta.url), 'utf8'),
  );
  const sites = applyProvinceRegions(map.sites, table);
  expect(sites.find((site) => site.name === '숭산')).toMatchObject({ region: 2 });
  expect(sites.find((site) => site.name === '경구')).toMatchObject({ region: 8 });
});

it('AC-INT-22: 155거점의 region만 바꾸고 원본·좌표·규모·연결은 보존한다', () => {
  const before = JSON.stringify(map);
  const table = fixture();
  const sites = applyProvinceRegions(map.sites, table);
  expect(sites.flatMap((site) => ('region' in site ? [site.region] : []))).toEqual(
    table.sites.map((site) => site.region),
  );
  expect(sites.map((site) => ({ ...site, region: 1 }))).toEqual(map.sites.map((site) => ({ ...site, region: 1 })));
  expect(JSON.stringify(map)).toBe(before);
});

it('빠진 거점·다른 거점·중복·이름 변경은 임의 보충 없이 생성을 거부한다', () => {
  const missing = fixture();
  missing.sites.pop();
  expect(() => applyProvinceRegions(map.sites, missing)).toThrow('전체와 정확히 대응');
  const foreign = fixture();
  foreign.sites[0]!.siteId = 'city:foreign';
  expect(() => applyProvinceRegions(map.sites, foreign)).toThrow('전체와 정확히 대응');
  const duplicate = fixture();
  duplicate.sites.push(duplicate.sites[0]!);
  expect(() => applyProvinceRegions(map.sites, duplicate)).toThrow('거점이 중복');
  const renamed = fixture();
  renamed.sites[0]!.name = '다른 이름';
  expect(() => applyProvinceRegions(map.sites, renamed)).toThrow('거점 이름');
});

it('모르는 출처·중복 출처·빈 인용·범위 밖 지역은 통과하지 못한다', () => {
  const absent = fixture();
  absent.sites[0]!.source = 'absent';
  expect(() => applyProvinceRegions(map.sites, absent)).toThrow('출처가 없습니다');
  const supporting = fixture();
  supporting.sites[0]!.supportingSources = ['absent'];
  expect(() => applyProvinceRegions(map.sites, supporting)).toThrow('출처가 없습니다');
  const duplicate = fixture();
  duplicate.sources.push(duplicate.sources[0]!);
  expect(() => applyProvinceRegions(map.sites, duplicate)).toThrow('출처가 중복');
  const empty = fixture();
  empty.sites[0]!.quote = '';
  expect(() => applyProvinceRegions(map.sites, empty)).toThrow();
  const outside = fixture();
  outside.sites[0]!.region = 17;
  expect(() => applyProvinceRegions(map.sites, outside)).toThrow();
});
