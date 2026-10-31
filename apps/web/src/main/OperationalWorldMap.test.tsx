// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MapCity, WorldMap as WorldMapResponse } from '../game/types';
import { WorldMap } from './WorldMap';
import { OPERATIONAL_GIS_SHA256 } from './operationalGeography';
import { publicGeographySchema } from '@opensamguk/shared';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
const san10Resource: unknown = JSON.parse(
  readFileSync(new NodeURL('../../../../resources/map/san10.json', import.meta.url), 'utf8'),
);
import { matchesOperationalGeography, operationalOverview } from './OperationalWorldMap';

afterEach(cleanup);
const makeCity = (key: number, name: string, kind: 'CITY' | 'PASS', x: number): MapCity => ({
  key,
  name,
  kind,
  x,
  y: 200,
  level: kind === 'CITY' ? 2 : 0,
  nationId: 1,
  supplied: true,
  links: key === 1 ? [2] : [1],
});
const cities = [makeCity(1, '허창', 'CITY', 300), makeCity(2, '관문', 'PASS', 600)];
const map: NonNullable<WorldMapResponse['operationalMap']> = {
  id: 'test',
  version: 3,
  canvas: { width: 1000, height: 700 },
  basemap: {
    source: 'natural-earth-5.1.2',
    projection: 'WGS84 plate carree',
    sha256: OPERATIONAL_GIS_SHA256,
    bounds: [94, 17, 132.57142857142856, 44],
  },
  sites: [
    { id: 'city:1', name: '허창', kind: 'CITY', anchorKey: 1, position: { x: 300, y: 200 } },
    { id: 'pass:2', name: '관문', kind: 'PASS', anchorKey: 2, position: { x: 600, y: 200 } },
    { id: 'port:3', name: '항구', kind: 'PORT', parentCityId: 'city:1', position: { x: 320, y: 220 } },
    { id: 'field:4', name: '전장', kind: 'FIELD', position: { x: 450, y: 200 } },
  ],
  routes: [
    { id: 'land:1', from: 'city:1', to: 'pass:2', mode: 'LAND', direction: 'BOTH', enabled: true, via: ['field:4'] },
    { id: 'land:2', from: 'city:1', to: 'pass:2', mode: 'LAND', direction: 'FORWARD', enabled: false },
  ],
};
const nations = [{ id: 1, name: '위', color: '#202020' }];
const draw = (override: Partial<typeof map> = {}) =>
  render(
    <WorldMap
      cities={cities}
      nations={nations}
      operationalMap={{ ...map, ...override }}
      myCityKey={1}
      selectedKey={2}
      onSelect={vi.fn()}
    />,
  );

it('AC-INT-20 도로를 도트 층으로 깔고 거점을 규모 표식과 국가 군기로 그린다', () => {
  const { container } = draw({
    routes: [
      ...map.routes,
      { id: 'land:3', from: 'pass:2', to: 'city:1', mode: 'LAND', direction: 'FORWARD', enabled: true },
    ],
  });
  const svg = container.querySelector('svg')!;
  expect(screen.getByTestId('road-pixels').querySelector('[data-road-mode="LAND"]')?.getAttribute('d')).toMatch(/^M/);
  // 경로 선은 경로마다 하나 남고 일방통행만 화살표를 단다.
  expect(svg.querySelectorAll('polyline[data-route-mode="LAND"]')).toHaveLength(2);
  expect(svg.querySelectorAll('polyline[marker-end]')).toHaveLength(1);
  expect(svg.querySelector('mask[id^="operational-flag-"]')).toBeTruthy();
  // jsdom은 크기를 0으로 읽으므로 표식은 국가색 네모로 줄어든다.
  const city = screen.getByTestId('site-icon-city').querySelector('[data-marker-detail="square"]');
  expect(city?.getAttribute('fill')).toBe('#202020');
  expect(screen.getByTestId('site-icon-field').querySelector('rect')?.getAttribute('fill')).toBe('#d6d0c4');
});

it('AC-INT-10 GIS 지형과 기존 도트·국가색을 그리고 항구·전장에는 이동 단추를 만들지 않는다', () => {
  const onSelect = vi.fn();
  render(
    <WorldMap
      cities={cities}
      nations={nations}
      operationalMap={map}
      myCityKey={1}
      selectedKey={2}
      onSelect={onSelect}
    />,
  );
  expect(screen.getByTestId('geographic-basemap')).toBeTruthy();
  expect(screen.getByTestId('geographic-relief').getAttribute('href')).toContain('pixel-basemap.png');
  for (const kind of ['city', 'pass', 'field']) expect(screen.getByTestId(`site-icon-${kind}`)).toBeTruthy();
  // INT-20: 켜진 물길이 쓰지 않는 항구 시설은 그리지 않는다.
  expect(screen.queryByTestId('site-icon-port')).toBeNull();
  expect(screen.getByRole('img', { name: '전장, 전장 표시' })).toBeTruthy();
  const pass = screen.getByRole('button', { name: '관문, 관문, 위' });
  expect(pass.getAttribute('aria-pressed')).toBe('true');
  fireEvent.keyDown(pass, { key: 'Enter' });
  expect(onSelect.mock.calls).toEqual([[2]]);
  expect(screen.getByTestId('world-map').querySelectorAll('polyline')).toHaveLength(1);
  expect(screen.getByTestId('world-map').querySelector('polyline')!.getAttribute('points')).toBe(
    '300,200 450,200 600,200',
  );
});

it('AC-INT-10 거점 목록은 도시·관문만 선택하고 확대·방향키·전체 복귀가 동작한다', () => {
  draw();
  const svg = screen.getByTestId('world-map');
  expect(svg.getAttribute('viewBox')).toBe('0 0 1000 700');
  expect(screen.getByRole('combobox', { name: '지도 거점' }).querySelectorAll('option')).toHaveLength(3);
  fireEvent.change(screen.getByRole('combobox', { name: '지도 거점' }), { target: { value: '2' } });
  expect(svg.getAttribute('viewBox')).toBe('350 25 500 350');
  fireEvent.keyDown(svg, { key: 'ArrowRight' });
  expect(svg.getAttribute('viewBox')).toBe('450 25 500 350');
  fireEvent.click(screen.getByRole('button', { name: '지도 확대' }));
  expect(Number(svg.getAttribute('viewBox')!.split(' ')[2])).toBeLessThan(500);
  fireEvent.click(screen.getByRole('button', { name: '지도 전체' }));
  expect(svg.getAttribute('viewBox')).toBe('0 0 1000 700');
});

it('AC-INT-10 수로는 출발 도시·항구·경유지·도착 항구·도시 순서로 그린다', () => {
  const destination = makeCity(2, '도착 도시', 'CITY', 600);
  render(
    <WorldMap
      cities={[cities[0]!, destination]}
      nations={nations}
      operationalMap={{
        ...map,
        sites: [
          map.sites[0]!,
          { ...map.sites[1]!, kind: 'CITY', name: destination.name },
          map.sites[2]!,
          map.sites[3]!,
          { id: 'port:5', name: '도착 항구', kind: 'PORT', parentCityId: 'pass:2', position: { x: 580, y: 220 } },
        ],
        routes: [
          {
            id: 'river:1',
            from: 'city:1',
            to: 'pass:2',
            mode: 'RIVER',
            direction: 'BOTH',
            enabled: true,
            portIds: ['port:3', 'port:5'],
            via: ['field:4'],
          },
        ],
      }}
    />,
  );
  expect(screen.getByTestId('world-map').querySelector('polyline')!.getAttribute('points')).toBe(
    '300,200 320,220 450,200 580,220 600,200',
  );
  // 물길이 쓰는 항구는 그리고 이동 단추는 만들지 않는다.
  expect(screen.getAllByTestId('site-icon-port')).toHaveLength(2);
  expect(screen.getByRole('img', { name: '항구, 항구 시설, 허창 소속' }).getAttribute('tabindex')).toBeNull();
});

it.each(['sha', 'position', 'missing', 'duplicate-id', 'duplicate-anchor'] as const)(
  'AC-INT-10 %s 판 불일치는 추정 지도 대신 재조회 안내를 보낸다',
  (kind) => {
    if (kind === 'missing') render(<WorldMap cities={cities} nations={nations} />);
    else
      draw(
        kind === 'duplicate-id'
          ? { sites: map.sites.map((site, index) => (index === 1 ? { ...site, id: map.sites[0]!.id } : site)) }
          : kind === 'duplicate-anchor'
            ? { sites: map.sites.map((site, index) => (index === 1 ? { ...site, anchorKey: 1 } : site)) }
            : kind === 'sha'
              ? { basemap: { ...map.basemap, sha256: '0'.repeat(64) } }
              : {
                  sites: map.sites.map((site) => (site.id === 'city:1' ? { ...site, position: { x: 1, y: 1 } } : site)),
                },
      );
    expect(screen.getByRole('alert').textContent).toContain('다시 불러오세요');
    expect(screen.queryByTestId('world-map')).toBeNull();
  },
);

it('AC-INT-03·10 SAN10의 153표식·200도로와 동북 끝점 전체 범위를 유지한다', () => {
  const geography = publicGeographySchema.parse(san10Resource);
  const strategic = geography.sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS');
  const mapped: MapCity[] = strategic.map((site) => ({
    ...makeCity(site.anchorKey!, site.name, site.kind as 'CITY' | 'PASS', site.position.x),
    y: site.position.y,
    links: [],
  }));
  expect(matchesOperationalGeography(geography, mapped)).toBe(true);
  const overview = operationalOverview(geography);
  for (const site of geography.sites) {
    expect(site.position.x).toBeGreaterThanOrEqual(overview.x);
    expect(site.position.x).toBeLessThanOrEqual(overview.x + overview.width);
    expect(site.position.y).toBeGreaterThanOrEqual(overview.y);
    expect(site.position.y).toBeLessThanOrEqual(overview.y + overview.height);
  }
  render(<WorldMap cities={mapped} nations={nations} operationalMap={geography} onSelect={vi.fn()} />);
  const svg = screen.getByTestId('world-map'),
    before = svg.getAttribute('viewBox');
  // D-049: SAN10 지도 자료에는 항구 시설이 없다.
  expect(svg.querySelectorAll('[data-site-kind]')).toHaveLength(153);
  expect(svg.querySelectorAll('[data-site-kind="PORT"]')).toHaveLength(0);
  expect(svg.querySelectorAll('[data-route-mode="LAND"]')).toHaveLength(200);
  expect(screen.getByTestId('geographic-relief').getAttribute('href')).toContain('san10-pixel-basemap.png');
  const yamatai = mapped.find((city) => city.name === '야마타이국')!;
  fireEvent.change(screen.getByRole('combobox', { name: '지도 거점' }), { target: { value: String(yamatai.key) } });
  expect(svg.getAttribute('viewBox')).toBe(before);
});

it('AC-INT-03 SAN10 GIS 해시·범위·도시 좌표가 다르면 다른 지도 묶음으로 대신 그리지 않는다', () => {
  const geography = publicGeographySchema.parse(san10Resource);
  const mapped: MapCity[] = geography.sites
    .filter((site) => site.kind === 'CITY' || site.kind === 'PASS')
    .map((site) => ({
      ...makeCity(site.anchorKey!, site.name, site.kind as 'CITY' | 'PASS', site.position.x),
      y: site.position.y,
      links: [],
    }));
  const changedHash = structuredClone(geography);
  changedHash.basemap.sha256 = '0'.repeat(64);
  expect(matchesOperationalGeography(changedHash, mapped)).toBe(false);
  const changedBounds = structuredClone(geography);
  changedBounds.basemap.bounds[0] += 1;
  expect(matchesOperationalGeography(changedBounds, mapped)).toBe(false);
  const changedCities = structuredClone(mapped);
  changedCities[0]!.x += 1;
  expect(matchesOperationalGeography(geography, changedCities)).toBe(false);
});
