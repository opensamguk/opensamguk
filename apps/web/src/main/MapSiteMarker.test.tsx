// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FlagMaskDef, MapSiteMarker } from './MapSiteMarker';
import { RoadPixelLayer } from './RoadPixelLayer';

afterEach(cleanup);

const draw = (pixelsPerUnit: number, color: string | null = '#3366aa', level = 8) =>
  render(
    <svg>
      <defs>
        <FlagMaskDef id="flag" />
      </defs>
      <MapSiteMarker
        x={100}
        y={100}
        kind="CITY"
        level={level}
        color={color}
        pixelsPerUnit={pixelsPerUnit}
        flagMaskId="flag"
      />
    </svg>,
  ).container;

it('AC-INT-20 멀리서는 국가색 네모, 가까이서는 원래 성 그림에 소속 깃발만 꽂는다', () => {
  const far = draw(0.5);
  const square = far.querySelector('[data-marker-detail="square"]')!;
  expect(square.getAttribute('fill')).toBe('#3366aa');
  expect(Number(square.getAttribute('width'))).toBe(12);
  cleanup();

  const near = draw(2);
  const marker = near.querySelector('[data-marker-detail="small"]')!;
  expect(marker.getAttribute('data-marker-art')).toBe('level-8');
  // 그림 위에 덧그린 성벽·성문 없이 그림 한 장과 깃발뿐이다.
  expect(marker.querySelectorAll(':scope > image')).toHaveLength(1);
  expect(marker.querySelector('[data-gate]')).toBeNull();
  const cloth = near.querySelector('[data-testid="marker-flag"] rect')!;
  expect(cloth.getAttribute('fill')).toBe('#3366aa');
  expect(cloth.getAttribute('mask')).toBe('url(#flag)');
  cleanup();

  expect(draw(5).querySelector('[data-marker-detail="large"]')).not.toBeNull();
  cleanup();
  expect(draw(4, '#3366aa', 2).querySelector('[data-marker-art="field"]')).not.toBeNull();
});

it('AC-INT-20 화면 크기를 읽기 전(배율 0)에도 표식 좌표·크기가 유한하다', () => {
  const square = draw(0).querySelector('[data-marker-detail="square"]')!;
  for (const name of ['x', 'y', 'width', 'height'])
    expect(Number.isFinite(Number(square.getAttribute(name)))).toBe(true);
  expect(Number(square.getAttribute('width'))).toBe(11);
});

it('AC-INT-20 아주 작은 네모도 화면에서 6px 아래로 줄지 않고 공백지는 군기를 달지 않는다', () => {
  const tiny = draw(0.25, null, 0).querySelector('[data-marker-detail="square"]')!;
  expect(Number(tiny.getAttribute('width')) * 0.25).toBe(6);
  cleanup();
  expect(draw(4, null).querySelector('[data-testid="marker-flag"]')).toBeNull();
});

it('AC-INT-20 도로 층은 길 종류마다 path 하나를 그린다', () => {
  const site = (id: string, x: number) => ({
    id,
    name: id,
    kind: 'CITY' as const,
    anchorKey: x,
    position: { x, y: 10 },
  });
  const { container } = render(
    <svg>
      <RoadPixelLayer
        map={{
          sites: [site('a', 10), site('b', 40)],
          routes: [{ id: 'r', from: 'a', to: 'b', mode: 'LAND', direction: 'BOTH', enabled: true }],
        }}
      />
    </svg>,
  );
  const paths = container.querySelectorAll('[data-testid="road-pixels"] path');
  expect([...paths].map((path) => path.getAttribute('data-road-mode'))).toEqual(['LAND']);
  expect(paths[0]!.getAttribute('d')).toBe('M10 10h32v2h-32z');
});
