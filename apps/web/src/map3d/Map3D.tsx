// 3D 군략도 (INT-27, D-089). 기울인 정사영 카메라로 높이 지형과 거점 모형을 그린다.
// 고르기·이름판은 3D 위에 띄운 DOM 단추라 키보드·화면 낭독·E2E 선택자(data-city-key)가 SVG 지도와 같다.
// 읽기 이름·풍선·지도 거점 고르기는 SVG 지도와 같은 지도 모형(main/mapModel)과 부품(main/MapParts)을 쓴다.
// 지연 로드 덩어리라 첫 화면 번들에 들어가지 않는다. 주소에 ?map=3d가 있고 WebGL2가 될 때만 쓴다(WorldMap).
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PublicGeography } from '@opensamguk/shared';
import { basemapForOperationalMap } from '../main/operationalGeography';
import { useTerrainGrid } from '../main/TerrainTileLayer';
import type { DrawnNation } from '../main/siteMarkers';
import type { MapGeneral } from '../main/mapGeneralList';
import { buildMapModel, describeSite, mapLabel, type ModelCity } from '../main/mapModel';
import { MapSiteChooser, MapTooltip, tooltipPlacement } from '../main/MapParts';
import { compactLabels, siteSize, type HeightData, type LabelBox } from './terrain3d';
import { ELEVATION, MapScene } from './mapScene';
import styles from './Map3D.module.css';

type DrawnCity = ModelCity;
type Site = PublicGeography['sites'][number];

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const frameRequest = useRef(0);
  const frames = useRef({ count: 0, since: 0, first: 0 });
  // 그릴 때마다 이름판에 쓰는 값. 렌더 함수가 늘 최신 값을 보게 ref로 둔다.
  const latest = useRef({ anchors, model, selectedKey, myCityKey });
  latest.current = { anchors, model, selectedKey, myCityKey };

  // 이름판·고르기 단추를 거점의 화면 위치로 옮긴다. 겹치는 이름판은 중요도 순으로 작은 점으로 줄인다.
  const placeLabels = (scene: MapScene) => {
    const box = frame.current;
    if (!box) return;
    const { anchors: sites, model: current, selectedKey: chosen, myCityKey: home } = latest.current;
    const buttons = overlay.current?.querySelectorAll<HTMLButtonElement>('button[data-site-id]') ?? [];
    const byId = new Map(sites.map((site) => [site.id, site]));
    const boxes: LabelBox[] = [];
    for (const button of buttons) {
      const site = byId.get(button.dataset.siteId!);
      if (!site) continue;
      const city = current.cityByKey.get(site.anchorKey);
      const { height } = siteSize(site.kind, city?.level);
      const { x, y } = scene.project(scene.world(site.position.x, site.position.y, height * 1.8 + 2));
      const inside = x > -40 && x < box.clientWidth + 40 && y > -20 && y < box.clientHeight + 20;
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
            (site.anchorKey === chosen ? 1000 : 0) +
            (site.anchorKey === home ? 900 : 0) +
            (site.kind === 'CITY' ? (city?.level ?? 1) * 10 : site.kind === 'PASS' ? 25 : 0),
        });
    }
    const compact = compactLabels(boxes);
    for (const button of buttons) button.dataset.compact = compact.has(button.dataset.siteId!) ? 'true' : 'false';
  };

  const draw = () => {
    frameRequest.current = 0;
    const scene = sceneRef.current;
    if (!scene) return;
    scene.render(control.current);
    placeLabels(scene);
    if (statLine.current) {
      const f = frames.current;
      const now = performance.now();
      if (!f.first) {
        f.first = now - started.current;
        f.since = now;
      }
      f.count++;
      if (now - f.since >= 1000) {
        statLine.current.textContent = `fps ${Math.round((f.count * 1000) / (now - f.since))} · 첫 프레임 ${Math.round(f.first)}ms · 거점 ${latest.current.anchors.length} · 길 ${map.routes.length}`;
        f.count = 0;
        f.since = now;
      }
      // 측정할 때는 계속 그린다.
      frameRequest.current = requestAnimationFrame(draw);
    }
  };
  invalidateRef.current = () => {
    if (!frameRequest.current) frameRequest.current = requestAnimationFrame(draw);
  };

  // 화면 크기에 맞춰 처음 배율을 정한다. focus가 있으면 그 거점을 가운데 두고 확대한다.
  const fitTo = (width: number, height: number) => {
    const c = control.current;
    const fit = Math.min(width / map.canvas.width, height / (map.canvas.height * Math.sin(ELEVATION)));
    const first = c.fit === 0;
    c.zoom = first ? fit : (c.zoom / c.fit) * fit;
    c.fit = fit;
    if (first && focusSite) {
      c.x = focusSite.position.x - map.canvas.width / 2;
      c.z = focusSite.position.y - map.canvas.height / 2;
      c.zoom = fit * focusZoom;
    }
    changed();
  };

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

  // 장면 만들기: 지형·높이 자료가 준비되면 한 번 만든다. 크기는 ResizeObserver로 따라간다.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = frame.current;
    if (!ready || !canvas || !box || !grid || !basemap) return;
    const scene = new MapScene(canvas, { map, grid, heights: usable, palette: basemap.palette });
    sceneRef.current = scene;
    scene.setSites(latest.current.anchors, latest.current.model.cityByKey, latest.current.model.nationById);
    const resize = () => {
      scene.resize(box.clientWidth, box.clientHeight);
      fitTo(box.clientWidth, box.clientHeight);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(box);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameRequest.current);
      frameRequest.current = 0;
      sceneRef.current = null;
      scene.dispose();
    };
    // 지형·높이 자료가 바뀔 때만 새로 만든다.
  }, [ready, grid, usable, map]);

  // 소유국·규모가 바뀌면 거점 모형을 다시 짓는다.
  useEffect(() => {
    sceneRef.current?.setSites(anchors, model.cityByKey, model.nationById);
    invalidateRef.current();
  }, [anchors, model]);

  // 고른 거점 고리와 이름판 우선순위.
  useEffect(() => {
    const site = anchors.find((entry) => entry.anchorKey === selectedKey) ?? null;
    sceneRef.current?.setSelected(site, site ? model.cityByKey.get(site.anchorKey)?.level : undefined);
    invalidateRef.current();
  }, [anchors, model, selectedKey, ready]);
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
          <canvas ref={canvasRef} className={styles.canvas} />
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
