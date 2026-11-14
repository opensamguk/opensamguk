// 3D 군략도 시제품 (INT-27 0단계, D-089). 기울인 정사영 카메라로 높이 지형과 거점 모형을 그린다.
// 고르기·이름판은 3D 위에 띄운 DOM 단추라 키보드·화면 낭독·E2E 선택자(data-city-key)가 SVG 지도와 같다.
// 지연 로드 덩어리라 첫 화면 번들에 들어가지 않는다. 주소에 ?map=3d가 있고 WebGL2가 될 때만 쓴다(WorldMap).
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Vector3,
  type OrthographicCamera,
} from 'three';
import type { PublicGeography } from '@opensamguk/shared';
import type { MapCity } from '../game/types';
import { basemapForOperationalMap } from '../main/operationalGeography';
import { useTerrainGrid } from '../main/TerrainTileLayer';
import type { DrawnNation } from '../main/siteMarkers';
import { levelName } from '../main/siteMarkers';
import {
  cellColors,
  compactLabels,
  groundAt,
  heightField,
  siteSize,
  type LabelBox,
  type TerrainCells,
} from './terrain3d';
import styles from './Map3D.module.css';

type DrawnCity = Pick<MapCity, 'key' | 'name' | 'kind' | 'x' | 'y' | 'nationId'> & { level?: number };
type Site = PublicGeography['sites'][number];

// 위에서 내려다보는 각도(수평에서 55°). 화면 위쪽이 북쪽이다.
const ELEVATION = (55 * Math.PI) / 180;
// 높이 과장 배율. 지형 높이(지도 단위)에 곱한다.
const HEIGHT_SCALE = 1;
const NEUTRAL = '#d6d0c4';
const WALL = '#cbbd9e';

export type Map3DProps = {
  cities: readonly DrawnCity[];
  nations: readonly DrawnNation[];
  map: PublicGeography;
  myCityKey: number | null;
  selectedKey: number | null;
  onSelect?: ((key: number) => void) | undefined;
  fill?: boolean | undefined;
};

export default function Map3D({ cities, nations, map, myCityKey, selectedKey, onSelect, fill = false }: Map3DProps) {
  const basemap = basemapForOperationalMap(map);
  const grid = useTerrainGrid(basemap?.pixels, basemap?.palette);
  const stats = useMemo(() => new URLSearchParams(window.location.search).get('stats') === '1', []);
  const overlay = useRef<HTMLDivElement>(null);
  const statLine = useRef<HTMLParagraphElement>(null);
  const control = useRef({ x: 0, z: 0, zoom: 0, version: 0 });
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const invalidateRef = useRef<() => void>(() => undefined);
  const started = useRef(performance.now());

  const anchors = useMemo(
    () => map.sites.filter((site): site is Site & { anchorKey: number } => site.anchorKey !== undefined),
    [map.sites],
  );
  const cityByKey = useMemo(() => new Map(cities.map((city) => [city.key, city])), [cities]);
  const nationById = useMemo(() => new Map(nations.map((nation) => [nation.id, nation])), [nations]);

  const pan = (dx: number, dy: number) => {
    const c = control.current;
    if (!c.zoom) return;
    c.x -= dx / c.zoom;
    c.z -= dy / (c.zoom * Math.sin(ELEVATION));
    c.x = Math.min(Math.max(c.x, -map.canvas.width / 2), map.canvas.width / 2);
    c.z = Math.min(Math.max(c.z, -map.canvas.height / 2), map.canvas.height / 2);
    c.version++;
    invalidateRef.current();
  };
  const zoomBy = (factor: number) => {
    const c = control.current;
    if (!c.zoom) return;
    c.zoom = Math.min(Math.max(c.zoom * factor, c.zoom > 0 ? 0.4 : 0.4), 40);
    c.version++;
    invalidateRef.current();
  };

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
    if (!d.moved) event.currentTarget.setPointerCapture(event.pointerId);
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

  useEffect(() => {
    const element = overlay.current?.parentElement;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  });

  const ready = grid !== null && basemap !== null;
  return (
    <div
      className={fill ? `${styles.frame} ${styles.fill}` : styles.frame}
      data-testid="map-3d"
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
            palette={basemap.palette}
            map={map}
            anchors={anchors}
            cityByKey={cityByKey}
            nationById={nationById}
            selectedKey={selectedKey}
            myCityKey={myCityKey}
            control={control}
            overlay={overlay}
            statLine={stats ? statLine : null}
            started={started}
            onInvalidate={(invalidate) => (invalidateRef.current = invalidate)}
          />
        </Canvas>
      ) : (
        <p className={styles.loading}>지형을 불러오는 중입니다</p>
      )}
      <div ref={overlay} className={styles.overlay} role="group" aria-label={`3D 중원 지도, 거점 ${anchors.length}곳`}>
        {ready
          ? anchors.map((site) => {
              const city = cityByKey.get(site.anchorKey);
              const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
              const level = levelName(city?.level);
              const selected = site.anchorKey === selectedKey;
              const mine = site.anchorKey === myCityKey;
              const label = [
                site.name,
                level ? `${level} 도시` : null,
                nation ? nation.name : '공백지',
                mine ? '내 도시' : null,
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <button
                  key={site.id}
                  type="button"
                  className={`${styles.site} ${selected ? styles.selected : ''} ${mine ? styles.mine : ''}`}
                  data-site-id={site.id}
                  data-city-key={site.anchorKey}
                  aria-label={label}
                  aria-pressed={selected}
                  disabled={!onSelect}
                  onClick={() => onSelect?.(site.anchorKey)}
                >
                  <span className={styles.name}>{site.name}</span>
                </button>
              );
            })
          : null}
      </div>
      <div className={styles.controls} role="group" aria-label="지도 배율">
        <button type="button" onClick={() => zoomBy(1.5)} aria-label="확대">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.5)} aria-label="축소">
          −
        </button>
      </div>
      {stats ? <p ref={statLine} className={styles.stats} data-testid="map-3d-stats" /> : null}
    </div>
  );
}

function Scene({
  grid,
  palette,
  map,
  anchors,
  cityByKey,
  nationById,
  selectedKey,
  myCityKey,
  control,
  overlay,
  statLine,
  started,
  onInvalidate,
}: {
  grid: TerrainCells;
  palette: NonNullable<ReturnType<typeof basemapForOperationalMap>>['palette'];
  map: PublicGeography;
  anchors: ReadonlyArray<Site & { anchorKey: number }>;
  cityByKey: ReadonlyMap<number, DrawnCity>;
  nationById: ReadonlyMap<number, DrawnNation>;
  selectedKey: number | null;
  myCityKey: number | null;
  control: RefObject<{ x: number; z: number; zoom: number; version: number }>;
  overlay: RefObject<HTMLDivElement | null>;
  statLine: RefObject<HTMLParagraphElement | null> | null;
  started: RefObject<number>;
  onInvalidate: (invalidate: () => void) => void;
}) {
  const { camera, size, invalidate } = useThree();
  const canvas = map.canvas;
  const field = useMemo(() => heightField(grid), [grid]);
  useEffect(() => onInvalidate(invalidate), [invalidate, onInvalidate]);

  // 지형: 칸 하나에 꼭짓점 하나. 위가 북쪽(z 음수)이다.
  const terrain = useMemo(() => {
    const geometry = new PlaneGeometry(canvas.width, canvas.height, grid.columns - 1, grid.rows - 1);
    geometry.rotateX(-Math.PI / 2);
    const position = geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) position.setY(i, field[i]! * HEIGHT_SCALE);
    geometry.setAttribute('color', new Float32BufferAttribute(cellColors(grid, palette, field), 3));
    geometry.computeVertexNormals();
    return geometry;
  }, [canvas.height, canvas.width, field, grid, palette]);

  const ground = (x: number, y: number) => groundAt(field, grid, canvas, x, y) * HEIGHT_SCALE;
  const world = (x: number, y: number, lift = 0) =>
    new Vector3(x - canvas.width / 2, ground(x, y) + lift, y - canvas.height / 2);

  // 거점 모형: 성벽 받침(상자)과 지붕(사각뿔). 지붕 색이 소유국 색이다.
  const models = useMemo(() => {
    const walls = new InstancedMesh(new BoxGeometry(1, 1, 1), undefined, anchors.length);
    const roofs = new InstancedMesh(new ConeGeometry(0.75, 1, 4), undefined, anchors.length);
    const matrix = new Matrix4();
    const color = new Color();
    anchors.forEach((site, index) => {
      const city = cityByKey.get(site.anchorKey);
      const { side, height } = siteSize(site.kind, city?.level);
      const base = world(site.position.x, site.position.y);
      matrix.makeScale(side, height, side).setPosition(base.x, base.y + height / 2, base.z);
      walls.setMatrixAt(index, matrix);
      walls.setColorAt(index, color.set(WALL));
      const roofHeight = Math.max(side * 0.45, 1.5);
      matrix
        .makeRotationY(Math.PI / 4)
        .scale(new Vector3(side, roofHeight, side))
        .setPosition(base.x, base.y + height + roofHeight / 2, base.z);
      roofs.setMatrixAt(index, matrix);
      const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
      roofs.setColorAt(index, color.set(nation?.color ?? NEUTRAL));
    });
    return { walls, roofs };
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

  // 처음에는 지도 전체가 화면에 들어오게 둔다.
  useEffect(() => {
    if (control.current.zoom) return;
    const fitWidth = size.width / canvas.width;
    const fitHeight = size.height / (canvas.height * Math.sin(ELEVATION));
    control.current.zoom = Math.min(fitWidth, fitHeight);
    control.current.version++;
    invalidate();
  }, [canvas.height, canvas.width, control, invalidate, size.height, size.width]);

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
      <hemisphereLight args={['#f4ecd8', '#5b4a35', 0.9]} />
      <directionalLight position={[-300, 500, -200]} intensity={1.4} />
      <mesh geometry={terrain}>
        <meshLambertMaterial vertexColors />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[canvas.width * 1.6, canvas.height * 1.6]} />
        <meshLambertMaterial color="#3a6584" transparent opacity={0.85} />
      </mesh>
      <lineSegments geometry={roads}>
        <lineBasicMaterial color="#6b4e2e" />
      </lineSegments>
      <primitive object={models.walls}>
        <meshLambertMaterial attach="material" />
      </primitive>
      <primitive object={models.roofs}>
        <meshLambertMaterial attach="material" />
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
