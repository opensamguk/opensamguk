import flagCloth from '../art/flag/tall-cloth.png';
import flagPole from '../art/flag/tall.png';
import { markerArt, markerBox, markerDetail, type PassAxis, type SiteKind } from './siteMarkers';

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
  const box = markerBox(kind, level, axis);
  const units = Math.max(box.width, box.height);
  const detail = markerDetail(units, pixelsPerUnit);
  if (detail === 'square') {
    // 화면 크기를 읽기 전(배율 0)에는 지도 단위 크기 그대로 둔다. 관은 같은 비율의 긴 네모다.
    const grow = pixelsPerUnit > 0 ? Math.max(1, SQUARE_MIN_PX / pixelsPerUnit / Math.min(box.width, box.height)) : 1;
    const width = box.width * grow;
    const height = box.height * grow;
    return (
      <rect
        data-marker-detail="square"
        x={x - width / 2}
        y={y - height / 2}
        width={width}
        height={height}
        fill={color ?? NEUTRAL}
        stroke="#221d17"
        strokeWidth={Math.min(1, 1 / pixelsPerUnit)}
      />
    );
  }
  const art = markerArt(kind, level, { ruined, axis });
  // 소속은 그림 위에 덧칠하지 않고 오른쪽 위 세력 색 깃발로만 나타낸다.
  const banner = color ? <MarkerFlag x={x} y={y} box={box} color={color} flagMaskId={flagMaskId} /> : null;
  return (
    <g data-marker-detail={detail} data-marker-art={art.name}>
      <image
        href={detail === 'large' ? art.large : art.small}
        x={x - box.width / 2}
        y={y - box.height / 2}
        width={box.width}
        height={box.height}
        style={{ imageRendering: 'pixelated' }}
      />
      {banner}
    </g>
  );
}

function MarkerFlag({
  x,
  y,
  box,
  color,
  flagMaskId,
}: {
  x: number;
  y: number;
  box: { width: number; height: number };
  color: string;
  flagMaskId: string;
}) {
  // 깃발 크기는 짧은 변이 아니라 긴 변 기준(정사각형 표식과 같은 비율)으로 정하고 오른쪽 위 모서리에 꽂는다.
  const flag = Math.max(box.width, box.height) * 0.5 * (box.width === box.height ? 1 : 0.6);
  const left = x + box.width / 2 - flag * 0.6;
  const top = y - box.height / 2 - flag * 0.6;
  return (
    <g data-testid="marker-flag">
      <rect x={left} y={top} width={flag} height={flag} fill={color} mask={`url(#${flagMaskId})`} />
      <image href={flagPole} x={left} y={top} width={flag} height={flag} style={{ imageRendering: 'pixelated' }} />
    </g>
  );
}
