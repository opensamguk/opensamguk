import flagCloth from '../art/flag/tall-cloth.png';
import flagPole from '../art/flag/tall.png';
import { markerArt, markerDetail, markerUnits, type PassAxis, type SiteKind } from './siteMarkers';

// 지도 표식 한 개 (INT-20). 지도 SVG 안에서 쓰며 좌표·크기는 1000×700 지도 단위다.
// 군기 천은 지도에 한 번 둔 FlagMaskDef를 마스크로 써서 국가색을 칠한다.

const SQUARE_MIN_PX = 6;
const NEUTRAL = '#d6d0c4';

export function FlagMaskDef({ id }: { id: string }) {
  return (
    <mask id={id} maskContentUnits="objectBoundingBox" style={{ maskType: 'alpha' }}>
      <image href={flagCloth} width="1" height="1" preserveAspectRatio="none" />
    </mask>
  );
}

export function MapSiteMarker({
  x,
  y,
  kind,
  level,
  ruined,
  axis,
  color,
  pixelsPerUnit,
  flagMaskId,
}: {
  x: number;
  y: number;
  kind: SiteKind;
  level?: number | undefined;
  ruined?: boolean | undefined;
  axis?: PassAxis | undefined;
  // 소속 국가색. 공백지와 시설은 null이고 군기를 달지 않는다.
  color: string | null;
  pixelsPerUnit: number;
  flagMaskId: string;
}) {
  const units = markerUnits(kind, level);
  const detail = markerDetail(units, pixelsPerUnit);
  if (detail === 'square') {
    const side = Math.max(units, SQUARE_MIN_PX / pixelsPerUnit);
    return (
      <rect
        data-marker-detail="square"
        x={x - side / 2}
        y={y - side / 2}
        width={side}
        height={side}
        fill={color ?? NEUTRAL}
        stroke="#221d17"
        strokeWidth={Math.min(1, 1 / pixelsPerUnit)}
      />
    );
  }
  const art = markerArt(kind, level, { ruined, axis });
  // 소속은 그림 위에 덧칠하지 않고 오른쪽 위 세력 색 깃발로만 나타낸다.
  const banner = color ? <MarkerFlag x={x} y={y} units={units} color={color} flagMaskId={flagMaskId} /> : null;
  return (
    <g data-marker-detail={detail} data-marker-art={art.name}>
      <image
        href={detail === 'large' ? art.large : art.small}
        x={x - units / 2}
        y={y - units / 2}
        width={units}
        height={units}
        style={{ imageRendering: 'pixelated' }}
      />
      {banner}
    </g>
  );
}

function MarkerFlag({
  x,
  y,
  units,
  color,
  flagMaskId,
}: {
  x: number;
  y: number;
  units: number;
  color: string;
  flagMaskId: string;
}) {
  const flag = units * 0.5;
  return (
    <g data-testid="marker-flag">
      <rect
        x={x + units / 2 - flag * 0.6}
        y={y - units / 2 - flag * 0.6}
        width={flag}
        height={flag}
        fill={color}
        mask={`url(#${flagMaskId})`}
      />
      <image
        href={flagPole}
        x={x + units / 2 - flag * 0.6}
        y={y - units / 2 - flag * 0.6}
        width={flag}
        height={flag}
        style={{ imageRendering: 'pixelated' }}
      />
    </g>
  );
}
