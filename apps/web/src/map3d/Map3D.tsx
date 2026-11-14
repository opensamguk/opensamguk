// 3D 군략도 (INT-27, D-089). 기울인 정사영 카메라로 높이 지형과 거점 모형을 그린다.
// 고르기·이름판은 3D 위에 띄운 DOM 단추라 키보드·화면 낭독·E2E 선택자(data-city-key)가 SVG 지도와 같다.
// 읽기 이름·풍선·지도 거점 고르기는 SVG 지도와 같은 지도 모형(main/mapModel)과 부품(main/MapParts)을 쓴다.
// 지연 로드 덩어리라 첫 화면 번들에 들어가지 않는다. 주소에 ?map=3d가 있고 WebGL2가 될 때만 쓴다(WorldMap).
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Vector3,
  type OrthographicCamera,
} from 'three';
import type { PublicGeography } from '@opensamguk/shared';
import { basemapForOperationalMap } from '../main/operationalGeography';
import { useTerrainGrid } from '../main/TerrainTileLayer';
import type { DrawnNation } from '../main/siteMarkers';
import type { MapGeneral } from '../main/mapGeneralList';
import { buildMapModel, describeSite, mapLabel, type ModelCity } from '../main/mapModel';
import { MapSiteChooser, MapTooltip, tooltipPlacement } from '../main/MapParts';
import {
  compactLabels,
  decodeMetres,
  groundAt,
  heightField,
  heightFieldFromMetres,
  realisticColors,
  siteSize,
  treeSpots,
  cellNoise,
  type HeightData,
  type LabelBox,
  type TerrainCells,
} from './terrain3d';
import styles from './Map3D.module.css';

type DrawnCity = ModelCity;
type Site = PublicGeography['sites'][number];

// 위에서 내려다보는 각도(수평에서 55°). 화면 위쪽이 북쪽이다.
const ELEVATION = (55 * Math.PI) / 180;
// 높이 과장 배율. 지형 높이(지도 단위)에 곱한다.
const HEIGHT_SCALE = 1;
const NEUTRAL = '#d6d0c4';
const WALL = '#cbbd9e';
const MAX_ZOOM_FACTOR = 12;

type Control = { x: number; z: number; zoom: number; fit: number; version: number };

export type Map3DProps = {
  cities: readonly DrawnCity[];
  nations: readonly DrawnNation[];
  map: PublicGeography;
  myCityKey: number | null;
  /** 내 국가. 주면 지도 거점 고르기를 본국·타국·공백지로 묶는다(SVG 지도와 같다). */
  myNationId?: number | null | undefined;
  selectedKey: number | null;
  onSelect?: ((key: number) => void) | undefined;
  generals?: readonly MapGeneral[] | undefined;
  fill?: boolean | undefined;
  /** 처음 열 때 이 거점을 가운데 두고 focusZoom배로 확대한다 (인자 입력 화면). */
  focusKey?: number | null | undefined;
  focusZoom?: number | undefined;
};

export default function Map3D({
  cities,
  nations,
  map,
  myCityKey,
  myNationId,
  selectedKey,
  onSelect,
  generals,
  fill = false,
  focusKey = null,
  focusZoom = 3,
}: Map3DProps) {
  const basemap = basemapForOperationalMap(map);
  const grid = useTerrainGrid(basemap?.pixels, basemap?.palette);
  // 실제 높이 자료(지도 판마다 따로 지연 로드). 못 받거나 칸 수가 다르면 지형 종류로 높이를 정한다.
  const [heights, setHeights] = useState<HeightData | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = map.id === 'san10' ? import('./heights/san10') : import('./heights/operational');
    load.then(
      (module) => live && setHeights(module),
      () => live && setHeights(null),
    );
    return () => {
      live = false;
    };
  }, [map.id]);
  const stats = useMemo(() => new URLSearchParams(window.location.search).get('stats') === '1', []);
  const frame = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const statLine = useRef<HTMLParagraphElement>(null);
  const control = useRef<Control>({ x: 0, z: 0, zoom: 0, fit: 0, version: 0 });
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const invalidateRef = useRef<() => void>(() => undefined);
  const started = useRef(performance.now());
  const [hover, setHover] = useState<{ siteId: string; x: number; y: number } | null>(null);
  const [factor, setFactor] = useState(1);

  const model = useMemo(() => buildMapModel({ map, cities, nations, generals }), [map, cities, nations, generals]);
  const anchors = useMemo(
    () => model.anchors.filter((site): site is Site & { anchorKey: number } => site.anchorKey !== undefined),
    [model],
  );
  const focusSite = focusKey === null ? undefined : anchors.find((site) => site.anchorKey === focusKey);

  const changed = () => {
    const c = control.current;
    c.version++;
    if (c.fit) setFactor(c.zoom / c.fit);
    invalidateRef.current();
  };
  // 보기가 지도 밖(빈 곳)을 비추지 않게 가운데를 묶는다. 지도보다 보기가 넓으면 가운데에 둔다.
  const clampCenter = () => {
    const c = control.current;
    const box = frame.current;
    if (!c.zoom || !box) return;
    const halfW = Math.max(map.canvas.width / 2 - box.clientWidth / c.zoom / 2, 0);
    const halfD = Math.max(map.canvas.height / 2 - box.clientHeight / (c.zoom * Math.sin(ELEVATION)) / 2, 0);
    c.x = Math.min(Math.max(c.x, -halfW), halfW);
    c.z = Math.min(Math.max(c.z, -halfD), halfD);
  };
  const pan = (dx: number, dy: number) => {
    const c = control.current;
    if (!c.zoom) return;
    c.x -= dx / c.zoom;
    c.z -= dy / (c.zoom * Math.sin(ELEVATION));
    clampCenter();
    changed();
  };
  const zoomBy = (by: number) => {
    const c = control.current;
    if (!c.zoom) return;
    c.zoom = Math.min(Math.max(c.zoom * by, c.fit), c.fit * MAX_ZOOM_FACTOR);
    clampCenter();
    changed();
  };
  const centerOn = (site: Site) => {
    const c = control.current;
    c.x = site.position.x - map.canvas.width / 2;
    c.z = site.position.y - map.canvas.height / 2;
    clampCenter();
    changed();
  };
  const choose = (key: number, center = false) => {
    if (!onSelect) return;
    onSelect(key);
    const site = anchors.find((entry) => entry.anchorKey === key);
    if (center && site) centerOn(site);
  };

  // 다른 곳(도시 칸·인자 화면)에서 고른 거점이 화면 밖이면 가운데로 옮긴다.
  useEffect(() => {
    if (selectedKey === null) return;
    const button = overlay.current?.querySelector<HTMLButtonElement>(`button[data-city-key="${selectedKey}"]`);
    const site = anchors.find((entry) => entry.anchorKey === selectedKey);
    if (button && site && button.style.visibility === 'hidden') centerOn(site);
    // 고른 거점이 바뀔 때만 본다.
  }, [selectedKey]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setHover(null);
    }
    d.moved = true;
    d.x = event.clientX;
    d.y = event.clientY;
    pan(dx, dy);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    // 끌기로 끝난 누르기는 거점 선택으로 치지 않는다.
    if (d?.moved) event.preventDefault();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const box = frame.current?.getBoundingClientRect();
    const step = { x: (box?.width ?? 500) / 5, y: (box?.height ?? 350) / 5 };
    const direction = (
      { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>
    )[event.key];
    if (direction) {
      event.preventDefault();
      pan(-direction[0]! * step.x, -direction[1]! * step.y);
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1.5);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(1 / 1.5);
    }
  };

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });

  const ready = grid !== null && basemap !== null && heights !== undefined;
  const usable = heights && grid && heights.columns === grid.columns && heights.rows === grid.rows ? heights : null;
  const hovered = hover ? model.siteById.get(hover.siteId) : undefined;
  return (
    <div className={fill ? `${styles.wrap} ${styles.wrapFill}` : styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.zoom} role="group" aria-label="지도 배율">
          <button type="button" aria-label="지도 확대" disabled={factor >= MAX_ZOOM_FACTOR} onClick={() => zoomBy(1.5)}>
            확대
          </button>
          <button type="button" aria-label="지도 축소" disabled={factor <= 1} onClick={() => zoomBy(1 / 1.5)}>
            축소
          </button>
          <button
            type="button"
            aria-label="지도 전체"
            onClick={() => {
              const c = control.current;
              c.x = 0;
              c.z = 0;
              c.zoom = c.fit;
              changed();
            }}
          >
            전체
          </button>
          <output aria-label="현재 지도 배율">{factor.toFixed(1)}배</output>
        </div>
        {onSelect ? (
          <MapSiteChooser
            model={model}
            selectedKey={selectedKey}
            myNationId={myNationId}
            onChoose={(key) => choose(key, true)}
          />
        ) : null}
      </div>
      <div
        ref={frame}
        className={fill ? `${styles.frame} ${styles.fill}` : styles.frame}
        data-testid="map-3d"
        role="group"
        aria-label={mapLabel(model, '3D 중원 지도')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        {ready ? (
          <Canvas
            className={styles.canvas}
            orthographic
            frameloop={stats ? 'always' : 'demand'}
            dpr={[1, 2]}
            camera={{ near: -4000, far: 4000, position: [0, 100, 100] }}
            gl={{ antialias: true }}
          >
            <Scene
              grid={grid}
              heights={usable}
              palette={basemap.palette}
              map={map}
              anchors={anchors}
              cityByKey={model.cityByKey}
              nationById={model.nationById}
              selectedKey={selectedKey}
              myCityKey={myCityKey}
              focus={focusSite ? { site: focusSite, zoom: focusZoom } : null}
              control={control}
              overlay={overlay}
              statLine={stats ? statLine : null}
              started={started}
              onInvalidate={(invalidate) => (invalidateRef.current = invalidate)}
              onFit={() => setFactor(control.current.zoom / control.current.fit)}
            />
          </Canvas>
        ) : (
          <p className={styles.loading}>지형을 불러오는 중입니다</p>
        )}
        <div ref={overlay} className={styles.overlay}>
          {ready
            ? anchors.map((site) => {
                const view = describeSite(model, site, { myCityKey, selectedKey });
                return (
                  <button
                    key={site.id}
                    type="button"
                    className={`${styles.site} ${view.selected ? styles.selected : ''} ${view.mine ? styles.mine : ''}`}
                    style={view.nation && !view.selected ? { borderLeft: `6px solid ${view.nation.color}` } : undefined}
                    data-site-id={site.id}
                    data-site-kind={site.kind}
                    data-city-key={site.anchorKey}
                    data-nation-id={view.city?.nationId ?? ''}
                    data-selected={view.selected || undefined}
                    data-mine={view.mine || undefined}
                    aria-label={view.label}
                    aria-pressed={onSelect ? view.selected : undefined}
                    disabled={!onSelect}
                    onClick={() => choose(site.anchorKey)}
                    onPointerMove={(event) => {
                      if (event.pointerType !== 'mouse' || drag.current?.moved) return;
                      const box = frame.current?.getBoundingClientRect();
                      if (box) setHover({ siteId: site.id, x: event.clientX - box.left, y: event.clientY - box.top });
                    }}
                    onPointerLeave={() => setHover((old) => (old?.siteId === site.id ? null : old))}
                  >
                    <span className={styles.name}>{view.plate}</span>
                  </button>
                );
              })
            : null}
        </div>
        {hover && hovered ? (
          <MapTooltip
            view={describeSite(model, hovered, { myCityKey, selectedKey })}
            model={model}
            style={tooltipPlacement(hover, {
              width: frame.current?.clientWidth ?? 0,
              height: frame.current?.clientHeight ?? 0,
            })}
          />
        ) : null}
        {stats ? <p ref={statLine} className={styles.stats} data-testid="map-3d-stats" /> : null}
      </div>
      <p className={styles.help}>드래그나 방향키로 이동 · 휠이나 +/−로 확대 · 거점 이름을 눌러 선택</p>
    </div>
  );
}

function Scene({
  grid,
  heights,
  palette,
  map,
  anchors,
  cityByKey,
  nationById,
  selectedKey,
  myCityKey,
  focus,
  control,
  overlay,
  statLine,
  started,
  onInvalidate,
  onFit,
}: {
  grid: TerrainCells;
  heights: HeightData | null;
  palette: NonNullable<ReturnType<typeof basemapForOperationalMap>>['palette'];
  map: PublicGeography;
  anchors: ReadonlyArray<Site & { anchorKey: number }>;
  cityByKey: ReadonlyMap<number, DrawnCity>;
  nationById: ReadonlyMap<number, DrawnNation>;
  selectedKey: number | null;
  myCityKey: number | null;
  focus: { site: Site; zoom: number } | null;
  control: RefObject<Control>;
  overlay: RefObject<HTMLDivElement | null>;
  statLine: RefObject<HTMLParagraphElement | null> | null;
  started: RefObject<number>;
  onInvalidate: (invalidate: () => void) => void;
  onFit: () => void;
}) {
  const { camera, size, invalidate } = useThree();
  const canvas = map.canvas;
  const metres = useMemo(() => (heights ? decodeMetres(heights) : null), [heights]);
  const field = useMemo(() => (metres ? heightFieldFromMetres(grid, metres) : heightField(grid)), [grid, metres]);
  useEffect(() => onInvalidate(invalidate), [invalidate, onInvalidate]);

  // 지형: 칸 하나에 꼭짓점 하나. 위가 북쪽(z 음수)이다. 색은 sRGB라 그리기 전에 선형으로 바꾼다.
  const terrain = useMemo(() => {
    const geometry = new PlaneGeometry(canvas.width, canvas.height, grid.columns - 1, grid.rows - 1);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) position.setY(i, field[i]! * HEIGHT_SCALE);
    const colors = realisticColors(grid, palette, field, metres);
    const linear = new Color();
    for (let i = 0; i < colors.length; i += 3) {
      linear.setRGB(colors[i]!, colors[i + 1]!, colors[i + 2]!).convertSRGBToLinear();
      colors[i] = linear.r;
      colors[i + 1] = linear.g;
      colors[i + 2] = linear.b;
    }
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return geometry;
  }, [canvas.height, canvas.width, field, grid, metres, palette]);

  const ground = (x: number, y: number) => groundAt(field, grid, canvas, x, y) * HEIGHT_SCALE;
  const world = (x: number, y: number, lift = 0) =>
    new Vector3(x - canvas.width / 2, ground(x, y) + lift, y - canvas.height / 2);

  // 숲: 숲·구릉 칸에 낮은 다각형 나무를 흩뿌린다. 거점 자리 가까이는 비운다.
  const trees = useMemo(() => {
    const clear = anchors.map((site) => site.position);
    const spots = treeSpots(grid, canvas, metres).filter(
      (spot) => !clear.some((at) => Math.abs(at.x - spot.x) < 9 && Math.abs(at.y - spot.y) < 9),
    );
    const mesh = new InstancedMesh(new ConeGeometry(0.9, 2.6, 6).translate(0, 1.3, 0), undefined, spots.length);
    const matrix = new Matrix4();
    const color = new Color();
    spots.forEach((spot, index) => {
      const base = world(spot.x, spot.y);
      matrix.makeScale(spot.scale, spot.scale, spot.scale).setPosition(base.x, base.y, base.z);
      mesh.setMatrixAt(index, matrix);
      const shade = cellNoise(index, 7);
      mesh.setColorAt(index, color.setRGB(0.16 + shade * 0.08, 0.3 + shade * 0.12, 0.14 + shade * 0.05));
    });
    return mesh;
  }, [anchors, canvas, field, grid, metres]);

  // 거점 모형: 도시는 네모 성벽과 네 모서리 망루, 가운데 본전과 소유국 색 지붕. 관문은 성문 벽과 양쪽 망루.
  const models = useMemo(() => {
    const parts = anchors.length * 4;
    const walls = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined, parts);
    const towers = new InstancedMesh(new CylinderGeometry(0.5, 0.6, 1, 6), undefined, parts);
    const keeps = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined, anchors.length);
    const roofs = new InstancedMesh(new ConeGeometry(0.75, 1, 4), undefined, anchors.length * 5);
    const matrix = new Matrix4();
    const color = new Color();
    let w = 0;
    let t = 0;
    let r = 0;
    const roof = (x: number, y: number, z: number, side: number, height: number, tint: string) => {
      matrix
        .makeRotationY(Math.PI / 4)
        .scale(new Vector3(side, height, side))
        .setPosition(x, y + height / 2, z);
      roofs.setMatrixAt(r, matrix);
      roofs.setColorAt(r++, color.set(tint));
    };
    anchors.forEach((site, index) => {
      const city = cityByKey.get(site.anchorKey);
      const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
      const tint = nation?.color ?? NEUTRAL;
      const { side, height } = siteSize(site.kind, city?.level);
      const base = world(site.position.x, site.position.y);
      const half = side / 2;
      const thick = Math.max(side * 0.1, 0.6);
      const towerSize = thick * 2.2;
      const sides =
        site.kind === 'PASS'
          ? [{ dx: 0, dz: 0, sx: side * 1.6, sz: thick * 1.6 }]
          : [
              { dx: 0, dz: -half, sx: side, sz: thick },
              { dx: 0, dz: half, sx: side, sz: thick },
              { dx: -half, dz: 0, sx: thick, sz: side },
              { dx: half, dz: 0, sx: thick, sz: side },
            ];
      for (const wall of sides) {
        matrix.makeScale(wall.sx, height, wall.sz).setPosition(base.x + wall.dx, base.y + height / 2, base.z + wall.dz);
        walls.setMatrixAt(w, matrix);
        walls.setColorAt(w++, color.set(WALL));
      }
      const corners =
        site.kind === 'PASS'
          ? [
              [-side * 0.8, 0],
              [side * 0.8, 0],
            ]
          : [
              [-half, -half],
              [half, -half],
              [-half, half],
              [half, half],
            ];
      for (const [dx, dz] of corners) {
        const towerHeight = height * 1.5;
        matrix
          .makeScale(towerSize, towerHeight, towerSize)
          .setPosition(base.x + dx!, base.y + towerHeight / 2, base.z + dz!);
        towers.setMatrixAt(t, matrix);
        towers.setColorAt(t++, color.set(WALL));
        roof(base.x + dx!, base.y + towerHeight, base.z + dz!, towerSize * 1.5, towerSize * 0.9, tint);
      }
      const keepSide = site.kind === 'PASS' ? side * 0.5 : side * 0.45;
      const keepHeight = height * (site.kind === 'PASS' ? 1.2 : 1.7);
      matrix.makeScale(keepSide, keepHeight, keepSide).setPosition(base.x, base.y + keepHeight / 2, base.z);
      keeps.setMatrixAt(index, matrix);
      keeps.setColorAt(index, color.set('#e9dfc8'));
      roof(base.x, base.y + keepHeight, base.z, keepSide * 1.45, keepSide * 0.7, tint);
    });
    walls.count = w;
    towers.count = t;
    roofs.count = r;
    return { walls, towers, keeps, roofs };
    // world는 field·grid·canvas에서 나온다.
  }, [anchors, cityByKey, nationById, field, grid, canvas]);

  // 길: 거점 사이 직선을 땅 위로 조금 띄운다(0단계). 지형을 따라 휘는 띠는 2단계에서 그린다.
  const roads = useMemo(() => {
    const byId = new Map(map.sites.map((site) => [site.id, site]));
    const points: number[] = [];
    for (const route of map.routes) {
      if (!route.enabled) continue;
      const path = [route.from, ...(route.via ?? []), route.to]
        .map((id) => byId.get(id))
        .filter((s) => s !== undefined);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!.position;
        const b = path[i]!.position;
        const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          const p0 = world(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0, 0.4);
          const p1 = world(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, 0.4);
          points.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
    return geometry;
  }, [map, field, grid, canvas]);

  const selected = anchors.find((site) => site.anchorKey === selectedKey);
  // 고른 거점이 바뀌면 이름판 우선순위가 바뀐다.
  useEffect(() => {
    control.current.version++;
    invalidate();
  }, [control, invalidate, selectedKey]);
  const selectedAt = selected ? world(selected.position.x, selected.position.y, 0.3) : null;

  // 처음에는 지도 전체가 화면에 들어오게 둔다. focus가 있으면 그 거점을 가운데 두고 확대한다.
  useEffect(() => {
    if (!size.width || !size.height) return;
    const c = control.current;
    const fitWidth = size.width / canvas.width;
    const fitHeight = size.height / (canvas.height * Math.sin(ELEVATION));
    const fit = Math.min(fitWidth, fitHeight);
    const first = c.fit === 0;
    c.zoom = first ? fit : (c.zoom / c.fit) * fit;
    c.fit = fit;
    if (first && focus) {
      c.x = focus.site.position.x - canvas.width / 2;
      c.z = focus.site.position.y - canvas.height / 2;
      c.zoom = fit * focus.zoom;
    }
    c.version++;
    onFit();
    invalidate();
    // 화면 크기가 바뀔 때만 다시 맞춘다.
  }, [size.width, size.height]);

  const seen = useRef(-1);
  const frames = useRef({ count: 0, since: performance.now(), first: 0 });
  const point = useMemo(() => new Vector3(), []);
  useFrame(() => {
    const c = control.current;
    const ortho = camera as OrthographicCamera;
    if (seen.current !== c.version) {
      const distance = 1000;
      ortho.position.set(c.x, Math.sin(ELEVATION) * distance, c.z + Math.cos(ELEVATION) * distance);
      ortho.lookAt(c.x, 0, c.z);
      ortho.zoom = c.zoom || 1;
      ortho.updateProjectionMatrix();
      ortho.updateMatrixWorld();
      seen.current = c.version;
      // 이름판·고르기 단추를 거점의 화면 위치로 옮긴다. 겹치는 이름판은 중요도 순으로 작은 점으로 줄인다.
      const buttons = overlay.current?.querySelectorAll<HTMLButtonElement>('button[data-site-id]') ?? [];
      const byId = new Map(anchors.map((site) => [site.id, site]));
      const boxes: LabelBox[] = [];
      for (const button of buttons) {
        const site = byId.get(button.dataset.siteId!);
        if (!site) continue;
        const city = cityByKey.get(site.anchorKey);
        const { height } = siteSize(site.kind, city?.level);
        const at = world(site.position.x, site.position.y, height + 2);
        point.copy(at).project(ortho);
        const x = ((point.x + 1) / 2) * size.width;
        const y = ((1 - point.y) / 2) * size.height;
        const inside = x > -40 && x < size.width + 40 && y > -20 && y < size.height + 20;
        button.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        button.style.visibility = inside ? 'visible' : 'hidden';
        if (inside)
          boxes.push({
            id: site.id,
            x,
            y: y - 12,
            width: site.name.length * 13 + 12,
            height: 24,
            priority:
              (site.anchorKey === selectedKey ? 1000 : 0) +
              (site.anchorKey === myCityKey ? 900 : 0) +
              (site.kind === 'CITY' ? (city?.level ?? 1) * 10 : site.kind === 'PASS' ? 25 : 0),
          });
      }
      const compact = compactLabels(boxes);
      for (const button of buttons) button.dataset.compact = compact.has(button.dataset.siteId!) ? 'true' : 'false';
    }
    if (statLine?.current) {
      const f = frames.current;
      if (!f.first) f.first = performance.now() - started.current;
      f.count++;
      const now = performance.now();
      if (now - f.since >= 1000) {
        statLine.current.textContent = `fps ${Math.round((f.count * 1000) / (now - f.since))} · 첫 프레임 ${Math.round(f.first)}ms · 거점 ${anchors.length} · 길 ${map.routes.length}`;
        f.count = 0;
        f.since = now;
      }
    }
  });

  return (
    <>
      <hemisphereLight args={['#f6f0e0', '#3e3222', 0.7]} />
      <directionalLight position={[-520, 360, -300]} intensity={2.8} color="#fff1d8" />
      <mesh geometry={terrain}>
        <meshStandardMaterial vertexColors roughness={0.95} metalness={0} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[canvas.width * 1.6, canvas.height * 1.6]} />
        <meshStandardMaterial color="#2f5f80" roughness={0.3} metalness={0.15} transparent opacity={0.9} />
      </mesh>
      <lineSegments geometry={roads}>
        <lineBasicMaterial color="#7a5a34" />
      </lineSegments>
      <primitive object={trees}>
        <meshStandardMaterial attach="material" roughness={0.9} />
      </primitive>
      <primitive object={models.walls}>
        <meshStandardMaterial attach="material" roughness={0.85} />
      </primitive>
      <primitive object={models.towers}>
        <meshStandardMaterial attach="material" roughness={0.85} />
      </primitive>
      <primitive object={models.keeps}>
        <meshStandardMaterial attach="material" roughness={0.8} />
      </primitive>
      <primitive object={models.roofs}>
        <meshStandardMaterial attach="material" roughness={0.6} />
      </primitive>
      {selectedAt ? (
        <mesh rotation-x={-Math.PI / 2} position={selectedAt}>
          <ringGeometry args={[7, 9, 32]} />
          <meshBasicMaterial color="#b23a2a" />
        </mesh>
      ) : null}
    </>
  );
}
