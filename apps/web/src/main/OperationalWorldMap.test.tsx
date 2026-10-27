// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MapCity, WorldMap as WorldMapResponse } from '../game/types';
import { WorldMap } from './WorldMap';
import { OPERATIONAL_GIS_SHA256 } from './operationalGeography';

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
  expect(screen.getByTestId('geographic-relief').getAttribute('href')).toContain('natural-earth-relief.webp');
  for (const kind of ['city', 'pass', 'port', 'field']) expect(screen.getByTestId(`site-icon-${kind}`)).toBeTruthy();
  expect(screen.getByRole('img', { name: '항구, 항구 시설, 허창 소속' }).getAttribute('tabindex')).toBeNull();
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
