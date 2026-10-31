import type { PublicGeography } from '@opensamguk/shared';
import { useMemo } from 'react';
import { ROAD_CELL, roadLayer, type RoadMode } from './roadPixels';

// 도로 픽셀 층 (INT-20). 땅길은 확대 길 타일과 같은 미색, 다리는 금니, 여울은 옅은 흙색 점선, 물길은 물빛 점선이다.
const FILL: Record<RoadMode, string> = {
  LAND: '#e9dcae',
  BRIDGE: '#a8822f',
  FORD: '#b9a27a',
  RIVER: '#9fc4d8',
};

// modes를 주면 그 길만 그린다. 확대 타일이 땅길·다리를 그릴 때 여울·물길만 남긴다.
export function RoadPixelLayer({
  map,
  modes,
  skip,
}: {
  map: Pick<PublicGeography, 'sites' | 'routes'>;
  modes?: readonly RoadMode[] | undefined;
  // 물길로 따로 그리는 경로 id.
  skip?: ReadonlySet<string> | undefined;
}) {
  const all = useMemo(() => roadLayer(map, skip), [map, skip]);
  const layers = modes ? all.filter((layer) => modes.includes(layer.mode)) : all;
  return (
    <g aria-hidden="true" pointerEvents="none" shapeRendering="crispEdges" data-testid="road-pixels">
      {layers.map((layer) => (
        <path key={layer.mode} data-road-mode={layer.mode} d={layer.d} fill={FILL[layer.mode]} />
      ))}
    </g>
  );
}

// 물길 표시 (화면만). 바다·강 칸을 따라 두 칸 찍고 두 칸 비운 자리에 작은 흰 물결 점을 둔다.
// 강 위에 강과 다른 색 띠를 그리면 강이 끊겨 보여 모든 배율에서 점만 쓴다.
export function WaterLaneLayer({
  lanes,
}: {
  lanes: readonly { id: string; cells: readonly { x: number; y: number }[] }[];
}) {
  const d = useMemo(
    () =>
      lanes
        .flatMap((lane) => lane.cells.filter((_, index) => Math.floor(index / 2) % 2 === 0))
        .map(({ x, y }) => `M${x * ROAD_CELL + 0.7} ${y * ROAD_CELL + 0.85}h0.6v0.3h-0.6z`)
        .join(''),
    [lanes],
  );
  return (
    <g aria-hidden="true" pointerEvents="none" shapeRendering="crispEdges" data-testid="water-lanes">
      <path d={d} fill="#eef4ff" fillOpacity={0.8} />
    </g>
  );
}
