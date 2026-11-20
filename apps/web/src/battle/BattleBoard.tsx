// 전술 전투 판 (D-099). 2:1 마름모 칸(D-097)에 지형·거점·부대·진로·이동 범위를 그린다.
// 작전 회의는 판 전체를 작게, 야전은 크게 쓴다. 칸을 누르면 onTile로 좌표를 알린다.
// D-105 야전 칸 규칙: 지물(다리, 성채, 진영, 마을, 흙더미, 무너진 터), 타는 칸, 시야 밖 가림, 이동과 공격 표시를 그린다.
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import { OBJECT_LABEL, battleArt, cellSet, fireArtName, placedObjects } from './fieldRules';
import type { BattleBase, BattleBoardData, BattleCell, BattleUnit, Side, Terrain } from './types';
import styles from './BattleBoard.module.css';

const TW = 64;
const TH = 32;

export const TERRAIN_FILL: Record<Terrain, string> = {
  plain: '#d9c9a0',
  grass: '#b9c27f',
  sandbar: '#e2cf9a',
  forest: '#6e8a4b',
  mountain: '#9a7953',
  river: '#6f9cb2',
  ford: '#97b8c0',
  bridge: '#a6845c',
  road: '#d2bb8e',
  marsh: '#8b9b6b',
  sea: '#4f7f9b',
};

export const TERRAIN_LABEL: Record<Terrain, string> = {
  plain: '평지',
  grass: '초원',
  sandbar: '모래톱',
  forest: '숲',
  mountain: '산',
  river: '강',
  ford: '여울',
  bridge: '다리',
  road: '가도',
  marsh: '습지',
  sea: '바다',
};

/** 칸 중심의 화면 좌표. */
export function tileCenter(x: number, y: number, height: number): [number, number] {
  return [(x - y + height - 1) * (TW / 2) + TW / 2, (x + y) * (TH / 2) + TH / 2];
}

function diamond(cx: number, cy: number, inset = 0) {
  const w = TW / 2 - inset;
  const h = TH / 2 - inset / 2;
  return `${cx},${cy - h} ${cx + w},${cy} ${cx},${cy + h} ${cx - w},${cy}`;
}

const keyOf = (x: number, y: number) => `${x},${y}`;

// 야전 그리드 자산은 칸 하나가 256×128이라 판(64×32)에서는 1/4로 줄인다 (README-FIELD-GRID.md).
// 지물 256×320은 칸 왼쪽 위보다 192 위에서, 효과 256×256은 128 위에서 그린다.
const ART = TW / 256;

// 지형 칸 그림 (Codex battlefield/tiles): 지형마다 3장, 칸 좌표로 골라 같은 지형이 줄무늬처럼 보이지 않게 한다.
// 숲과 산은 256×192라 칸 위로 솟는다. 그림이 승인 목록에 없으면 색 칸만 그린다.
const TALL: ReadonlySet<Terrain> = new Set(['forest', 'mountain']);
export function tileArt(terrain: Terrain, x: number, y: number): string | null {
  const source = `apps/web/src/art/battle/tiles/${terrain}-${((x * 7 + y * 3) % 3) + 1}.webp`;
  return hasPublicImage(source) ? publicImageUrl(source) : null;
}

// 병종 그림 (Codex battle-units). 병사 한 명을 방향마다 그렸다.
// - 8방향 판 units8/<id>: 1280×512, 5열(화면 아래, 오른쪽 아래, 오른쪽, 오른쪽 위, 위) × 2행(서 있기, 공격).
//   왼쪽 세 방향은 오른쪽 칸을 좌우로 뒤집어 쓴다.
// - 옛 판 units/<id>: 512×512, 2×2(오른쪽 아래 서기, 오른쪽 아래 공격, 왼쪽 위 서기, 왼쪽 위 공격). 8방향 판이 없을 때만 쓴다.
type UnitArt = { url: string; eight: boolean };
function unitArt(crewTypeId: number | null | undefined): UnitArt | null {
  if (crewTypeId == null) return null;
  const eight = `apps/web/src/art/battle/units8/${crewTypeId}.webp`;
  if (hasPublicImage(eight)) return { url: publicImageUrl(eight), eight: true };
  const old = `apps/web/src/art/battle/units/${crewTypeId}.webp`;
  return hasPublicImage(old) ? { url: publicImageUrl(old), eight: false } : null;
}

// 화면 8방향: 0 아래, 1 오른쪽 아래, 2 오른쪽, 3 오른쪽 위, 4 위, 5 왼쪽 위, 6 왼쪽, 7 왼쪽 아래.
// 전술 전투는 이웃 8칸으로 움직이고(체비셰프 거리), 마름모로 눕힌 칸에서 그 8칸이 화면 8방향이 된다.
export function screenFacing(dx: number, dy: number): number {
  // 화면 아래가 0, 시계 반대 방향(오른쪽 아래가 1)으로 45도씩.
  const angle = Math.atan2(dx, dy);
  return (Math.round(angle / (Math.PI / 4)) + 8) % 8;
}
// 방향과 자세로 그림 칸(열, 행)과 좌우 뒤집기를 고른다.
export function unitFrame(art: UnitArt, facing: number, attacking: boolean) {
  const row = attacking ? 1 : 0;
  if (art.eight) {
    const col = facing <= 4 ? facing : 8 - facing;
    return { col, row, flip: facing > 4, cols: 5, rows: 2 };
  }
  // 옛 판: 앞모습(오른쪽 아래)과 뒷모습(왼쪽 위) 두 방향뿐이라 가까운 쪽을 쓴다.
  const front = facing <= 2 || facing === 7;
  const flip = front ? facing === 7 || facing === 0 : facing === 2 || facing === 3;
  return { col: row, row: front ? 0 : 1, flip, cols: 2, rows: 2 };
}

/** 칸 크기 판 표시(이동, 공격, 고름, 가림)를 칸 위에 깐다. 그림이 없으면 같은 자리에 도형을 그린다. */
function CellMark({ cx, cy, art, fallback }: { cx: number; cy: number; art: string; fallback: string }) {
  const url = battleArt(art);
  return url ? (
    <image
      href={url}
      x={cx - TW / 2}
      y={cy - TH / 2}
      width={TW}
      height={TH}
      className={styles.mark}
      data-mark={art.slice('marks/'.length)}
    />
  ) : (
    <polygon points={diamond(cx, cy, 4)} className={fallback} />
  );
}

/** 가로로 이어 붙인 여러 장 그림을 한 장씩 넘긴다(CSS steps). 한 장은 frameW×frameH, 판에는 w×h로 놓는다. */
function StripSprite({
  url,
  x,
  y,
  w,
  h,
  frameW,
  frameH,
  frames,
  className,
}: {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frameW: number;
  frameH: number;
  frames: number;
  className: string;
}) {
  return (
    <svg x={x} y={y} width={w} height={h} viewBox={`0 0 ${frameW} ${frameH}`} className={styles.strip}>
      <image href={url} width={frameW * frames} height={frameH} className={className} />
    </svg>
  );
}

export function BattleBoard({
  board,
  units,
  bases,
  sideColor,
  paths = [],
  reach,
  attack,
  selectedId = null,
  burning,
  visible,
  onTile,
  compact = false,
  fit = false,
  label,
}: {
  board: BattleBoardData;
  units: readonly BattleUnit[];
  bases: readonly BattleBase[];
  sideColor: Record<Side, string>;
  /** 진로 화살표(칸 좌표 목록) */
  paths?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** 이동 가능한 칸 */
  reach?: ReadonlySet<string> | undefined;
  /** 칠 수 있는 적 칸 */
  attack?: ReadonlySet<string> | undefined;
  selectedId?: number | null;
  /** 타는 칸 (frames[].burningCells) */
  burning?: readonly BattleCell[] | undefined;
  /** 보이는 칸 (frames[].visibleCells). 없으면 가리지 않는다. */
  visible?: readonly BattleCell[] | undefined;
  onTile?: ((x: number, y: number) => void) | undefined;
  compact?: boolean;
  /** 화면을 채우는 배치: 감싸개 크기에 맞추고 바탕을 비운다. */
  fit?: boolean;
  label: string;
}) {
  const width = (board.width + board.height) * (TW / 2);
  const height = (board.width + board.height) * (TH / 2) + 40;
  // 칸을 누르는 함수는 부모가 그릴 때마다 새로 오므로, 칸 층을 다시 만들지 않게 ref로 넘긴다.
  const onTileRef = useRef(onTile);
  onTileRef.current = onTile;
  const interactive = Boolean(onTile);
  const [hover, setHover] = useState<readonly [number, number] | null>(null);
  const seen = useMemo(() => cellSet(visible), [visible]);
  const fire = useMemo(() => cellSet(burning) ?? new Set<string>(), [burning]);
  const hidden = (x: number, y: number) => seen !== null && !seen.has(keyOf(x, y));

  const tiles = useMemo(() => {
    const bridges = new Set((board.objects ?? []).filter((o) => o.kind === 'bridge').map((o) => keyOf(o.x, o.y)));
    const cells: Array<{ x: number; y: number; terrain: Terrain }> = [];
    for (let y = 0; y < board.height; y++)
      for (let x = 0; x < board.width; x++)
        cells.push({ x, y, terrain: board.terrain[y * board.width + x] ?? 'plain' });
    // 솟은 칸이 뒤 칸을 덮도록 먼 칸부터 그린다.
    cells.sort((a, b) => a.x + a.y - (b.x + b.y));
    return cells.map(({ x, y, terrain }) => {
      const [cx, cy] = tileCenter(x, y, board.height);
      // 다리 지물이 선 칸은 물 칸을 깔고 그 위에 다리 그림을 세운다.
      const art = tileArt(bridges.has(keyOf(x, y)) && terrain === 'bridge' ? 'river' : terrain, x, y);
      const tall = TALL.has(terrain);
      return (
        <g
          key={keyOf(x, y)}
          data-fog={seen !== null && !seen.has(keyOf(x, y)) ? 'true' : undefined}
          onClick={interactive ? () => onTileRef.current?.(x, y) : undefined}
          onMouseEnter={interactive ? () => setHover([x, y]) : undefined}
        >
          <polygon
            points={diamond(cx, cy)}
            fill={TERRAIN_FILL[terrain]}
            className={styles.tile}
            data-reach={reach?.has(keyOf(x, y)) ? 'true' : undefined}
          >
            <title>{`${TERRAIN_LABEL[terrain]} (${x}, ${y})`}</title>
          </polygon>
          {art ? (
            <image
              href={art}
              x={cx - TW / 2}
              y={tall ? cy + TH / 2 - TW * 0.75 : cy - TH / 2}
              width={TW}
              height={tall ? TW * 0.75 : TH}
              className={styles.tileArt}
            />
          ) : null}
        </g>
      );
    });
  }, [board, reach, seen, interactive]);

  // 칸 위에 까는 표시: 시야 밖 가림, 이동 범위, 공격 대상, 고른 부대, 커서.
  const marks = [];
  if (seen)
    for (let y = 0; y < board.height; y++)
      for (let x = 0; x < board.width; x++) {
        if (seen.has(keyOf(x, y))) continue;
        const [cx, cy] = tileCenter(x, y, board.height);
        marks.push(<CellMark key={`f${keyOf(x, y)}`} cx={cx} cy={cy} art="marks/fog" fallback={styles.fogShade!} />);
      }
  for (const key of reach ?? []) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    const [cx, cy] = tileCenter(x, y, board.height);
    marks.push(<CellMark key={`r${key}`} cx={cx} cy={cy} art="marks/move" fallback={styles.reach!} />);
  }
  for (const key of attack ?? []) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    const [cx, cy] = tileCenter(x, y, board.height);
    marks.push(<CellMark key={`a${key}`} cx={cx} cy={cy} art="marks/attack" fallback={styles.attackShade!} />);
  }
  const selectedUnit = units.find((unit) => unit.id === selectedId && unit.status !== 'routed');
  if (selectedUnit) {
    const [cx, cy] = tileCenter(selectedUnit.x, selectedUnit.y, board.height);
    const url = battleArt('marks/selected');
    if (url)
      marks.push(
        <image
          key="selected"
          href={url}
          x={cx - TW / 2}
          y={cy - TH / 2}
          width={TW}
          height={TH}
          className={styles.mark}
        />,
      );
  }
  const cursorUrl = interactive && hover ? battleArt('marks/cursor') : null;
  if (cursorUrl && hover) {
    const [cx, cy] = tileCenter(hover[0], hover[1], board.height);
    marks.push(
      <StripSprite
        key="cursor"
        url={cursorUrl}
        x={cx - TW / 2}
        y={cy - TH / 2}
        w={TW}
        h={TH}
        frameW={256}
        frameH={128}
        frames={2}
        className={styles.cursorStrip!}
      />,
    );
  }

  const arrows = paths.map((path, index) => {
    const points = path.map(([x, y]) => tileCenter(x, y, board.height));
    const d = points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px},${py}`).join(' ');
    return <path key={index} d={d} className={styles.route} markerEnd="url(#battle-arrow)" />;
  });

  // 칸 위에 서는 것(지물, 거점 표, 불, 부대)은 깊이(x + y) 순으로 한데 그려 앞의 것이 뒤의 것을 가린다.
  type Thing = { depth: number; order: number; node: ReactNode };
  const things: Thing[] = [];
  for (const object of placedObjects(board, bases)) {
    const url = battleArt(object.art);
    if (!url) continue;
    const [cx, cy] = tileCenter(object.x, object.y, board.height);
    things.push({
      depth: object.x + object.y,
      order: 0,
      node: (
        <image
          key={`o${keyOf(object.x, object.y)}`}
          href={url}
          x={cx - TW / 2}
          y={cy - TH / 2 - 192 * ART}
          width={TW}
          height={320 * ART}
          className={styles.object}
          data-kind={object.kind}
          data-fog={hidden(object.x, object.y) ? 'true' : undefined}
        >
          <title>{OBJECT_LABEL[object.kind]}</title>
        </image>
      ),
    });
  }
  for (const base of bases) {
    const [cx, cy] = tileCenter(base.x, base.y, board.height);
    const fill = base.owner ? sideColor[base.owner] : '#ffffff';
    things.push({
      depth: base.x + base.y,
      order: 1,
      node:
        base.kind === 'contest' ? (
          <polygon key={`b${base.id}`} points={diamond(cx, cy, 14)} fill={fill} className={styles.base}>
            <title>다툼 거점</title>
          </polygon>
        ) : (
          <circle key={`b${base.id}`} cx={cx} cy={cy} r={7} fill={fill} className={styles.supply}>
            <title>보급 거점</title>
          </circle>
        ),
    });
  }
  for (const key of fire) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    const [cx, cy] = tileCenter(x, y, board.height);
    const url = battleArt(fireArtName(board, fire, x, y));
    things.push({
      depth: x + y,
      order: 2,
      node: url ? (
        <g key={`fire${key}`} data-burning="true">
          <title>{`불 (${x}, ${y})`}</title>
          <StripSprite
            url={url}
            x={cx - TW / 2}
            y={cy - TH / 2 - 128 * ART}
            w={TW}
            h={256 * ART}
            frameW={256}
            frameH={256}
            frames={4}
            className={styles.fireStrip!}
          />
        </g>
      ) : (
        <polygon key={`fire${key}`} points={diamond(cx, cy, 6)} className={styles.fireShade} data-burning="true">
          <title>{`불 (${x}, ${y})`}</title>
        </polygon>
      ),
    });
  }
  for (const unit of units) {
    if (unit.status === 'routed') continue;
    const [cx, cy] = tileCenter(unit.x, unit.y, board.height);
    const sprite = unitArt(unit.crewTypeId);
    // 가장 가까운 적을 향한다. 붙어 있으면(이웃 칸) 공격 자세다.
    let nearest: BattleUnit | null = null;
    for (const other of units)
      if (other.side !== unit.side && other.troops > 0)
        if (
          !nearest ||
          Math.max(Math.abs(other.x - unit.x), Math.abs(other.y - unit.y)) <
            Math.max(Math.abs(nearest.x - unit.x), Math.abs(nearest.y - unit.y))
        )
          nearest = other;
    const facing = nearest
      ? (() => {
          const [tx, ty] = tileCenter(nearest.x, nearest.y, board.height);
          return screenFacing(tx - cx, ty - cy);
        })()
      : unit.side === 'attack'
        ? 1
        : 7;
    const attacking = nearest !== null && Math.max(Math.abs(nearest.x - unit.x), Math.abs(nearest.y - unit.y)) <= 1;
    const frame = sprite ? unitFrame(sprite, facing, attacking) : null;
    const ratio = unit.troopsMax > 0 ? Math.max(0, Math.min(1, unit.troops / unit.troopsMax)) : 0;
    things.push({
      depth: unit.x + unit.y,
      order: 3,
      node: (
        <g
          key={`u${unit.id}`}
          className={styles.unit}
          data-selected={selectedId === unit.id ? 'true' : undefined}
          data-status={unit.status}
          onClick={onTile ? () => onTile(unit.x, unit.y) : undefined}
        >
          <title>{`${unit.generalName}, ${unit.crewTypeName} ${unit.troops.toLocaleString()}`}</title>
          <polygon points={diamond(cx, cy, 2)} className={styles.footprint} stroke={sideColor[unit.side]} />
          {sprite && frame ? (
            <>
              {/* 발밑 세력색 그림자로 편을 가른다. */}
              <ellipse cx={cx} cy={cy + 2} rx={15} ry={6} fill={sideColor[unit.side]} className={styles.unitShadow} />
              {/* 바라보는 방향의 칸을 잘라 세운다. 왼쪽 방향은 오른쪽 칸을 좌우로 뒤집는다. */}
              <g transform={frame.flip ? `translate(${cx * 2},0) scale(-1,1)` : undefined}>
                <svg
                  x={cx - 26}
                  y={cy - 46}
                  width={52}
                  height={52}
                  viewBox={`${frame.col * 256} ${frame.row * 256} 256 256`}
                  className={styles.unitSprite}
                  data-facing={facing}
                  data-pose={attacking ? 'attack' : 'stand'}
                >
                  <image href={sprite.url} width={frame.cols * 256} height={frame.rows * 256} />
                </svg>
              </g>
            </>
          ) : (
            <>
              <rect
                x={cx - 9}
                y={cy - 34}
                width={18}
                height={26}
                fill={sideColor[unit.side]}
                className={styles.token}
              />
              <text x={cx} y={cy - 16} className={styles.crew}>
                {unit.crewTypeName.slice(0, 1)}
              </text>
            </>
          )}
          {unit.role === 'commander' ? <circle cx={cx + 10} cy={cy - 34} r={4} className={styles.commander} /> : null}
          {compact ? null : (
            <>
              <rect x={cx - 22} y={cy + 4} width={44} height={11} className={styles.troopsBg} />
              <rect x={cx - 22} y={cy + 13} width={44 * ratio} height={2} fill={sideColor[unit.side]} />
              <text x={cx} y={cy + 12.5} className={styles.troops}>
                {unit.troops.toLocaleString()}
              </text>
            </>
          )}
        </g>
      ),
    });
  }
  things.sort((a, b) => a.depth - b.depth || a.order - b.order);

  return (
    <svg
      className={styles.board}
      data-compact={compact ? 'true' : undefined}
      data-fit={fit ? 'true' : undefined}
      // 지물 그림은 칸 위로 48만큼 솟으므로 위쪽 여백을 넉넉히 둔다.
      viewBox={`0 -56 ${width} ${height + 36}`}
      role="img"
      aria-label={label}
      onMouseLeave={interactive ? () => setHover(null) : undefined}
    >
      <defs>
        <marker id="battle-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className={styles.arrowHead} />
        </marker>
      </defs>
      <g>{tiles}</g>
      <g className={styles.marks}>{marks}</g>
      <g>{arrows}</g>
      <g>{things.map((thing) => thing.node)}</g>
    </svg>
  );
}

/** 이동 범위: 지형 비용으로 기동력 안의 칸을 찾는다. 다른 부대가 있는 칸은 지나가지 못한다. 수치는 D-105 전술 이동 점수다. */
export const MOVE_COST: Record<Terrain, number> = {
  plain: 1,
  road: 1,
  grass: 1,
  bridge: 1,
  sandbar: 1.5,
  forest: 2,
  marsh: 2,
  ford: 2,
  mountain: 3,
  river: 99,
  sea: 99,
};

export function moveReach(
  board: BattleBoardData,
  units: readonly BattleUnit[],
  unit: BattleUnit,
  mobility: number,
): Set<string> {
  const blocked = new Set(units.filter((u) => u.id !== unit.id && u.status !== 'routed').map((u) => keyOf(u.x, u.y)));
  // 무너진 터는 들어가는 비용이 1 늘어난다 (D-105).
  const rubble = new Set((board.objects ?? []).filter((o) => o.kind === 'rubble').map((o) => keyOf(o.x, o.y)));
  const best = new Map<string, number>([[keyOf(unit.x, unit.y), 0]]);
  const queue: Array<[number, number, number]> = [[unit.x, unit.y, 0]];
  while (queue.length > 0) {
    queue.sort((a, b) => a[2] - b[2]);
    const [x, y, spent] = queue.shift()!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= board.width || ny >= board.height) continue;
      const key = keyOf(nx, ny);
      if (blocked.has(key)) continue;
      const cost = spent + MOVE_COST[board.terrain[ny * board.width + nx] ?? 'plain'] + (rubble.has(key) ? 1 : 0);
      if (cost > mobility || cost >= (best.get(key) ?? Infinity)) continue;
      best.set(key, cost);
      queue.push([nx, ny, cost]);
    }
  }
  best.delete(keyOf(unit.x, unit.y));
  return new Set(best.keys());
}
