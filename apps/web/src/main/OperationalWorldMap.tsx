import type { PublicGeography } from '@opensamguk/shared';
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { MapCity } from '../game/types';
import { readableTextColor } from '../ui/color';
import { FlagMaskDef, MapSiteMarker } from './MapSiteMarker';
import { RoadPixelLayer, WaterLaneLayer } from './RoadPixelLayer';
import { TerrainTileLayer, useTerrainGrid } from './TerrainTileLayer';
import { roadWalks, showTiles, waterLanes } from './terrainTiles';
import { ROAD_CELL, passNeighbours } from './roadPixels';
import {
  CAPITAL_MARK,
  isCapital,
  levelName,
  markerBox,
  markerGates,
  markerUnits,
  passAxis,
  type DrawnNation,
} from './siteMarkers';
import type { SiteGate } from './terrainTiles';
import { basemapForOperationalMap } from './operationalGeography';
import { mapTapTargets, tapCandidates, type MapView } from './mapTapTargets';
import styles from './OperationalWorldMap.module.css';

type MapData = PublicGeography;
type DrawnCity = Pick<MapCity, 'key' | 'name' | 'kind' | 'x' | 'y' | 'nationId'> & {
  supplied?: boolean;
  recorded?: boolean;
  level?: number;
};
type View = MapView;
const labels = { CITY: '도시', PASS: '관문', PORT: '항구 시설', FIELD: '전장 표시' };
// 툴팁 오른쪽 위의 한 글자 표기. 도시는 규모(특·대·중·소 …)를 쓴다.
const shortLabels = { CITY: '도시', PASS: '관', PORT: '항', FIELD: '전장' };
// 가장 깊이 확대한 보기 너비(지도 단위). 가장 큰 표식(경 13단위)도 화면 하나에 거의 차게 보인다.
export const MIN_VIEW_WIDTH = 8;
const clamp = (view: View, canvas: MapData['canvas']): View => ({
  ...view,
  x: Math.max(0, Math.min(canvas.width - view.width, view.x)),
  y: Math.max(0, Math.min(canvas.height - view.height, view.y)),
});

/** 지도 점 (cx, cy)를 화면의 같은 자리에 둔 채 factor배 확대한다. 너비는 [MIN_VIEW_WIDTH, maxWidth]로 묶는다. */
export function zoomAround(view: View, factor: number, cx: number, cy: number, maxWidth: number, ratio: number): View {
  const width = Math.min(maxWidth, Math.max(MIN_VIEW_WIDTH, view.width / factor));
  const scale = width / view.width;
  return { x: cx - (cx - view.x) * scale, y: cy - (cy - view.y) * scale, width, height: width * ratio };
}

// 휠 한 번(100px)에 약 1.35배. 터치패드의 작은 이동도 같은 비율로 부드럽게 따라간다.
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.min(2, Math.max(0.5, Math.exp(-pixels * 0.003)));
}

export function operationalOverview(map: MapData): View {
  if (map.id !== 'san10') return { x: 0, y: 0, width: map.canvas.width, height: map.canvas.height };
  const xs = map.sites.map((site) => site.position.x),
    ys = map.sites.map((site) => site.position.y);
  const x = Math.max(0, Math.min(...xs) - 55),
    y = Math.max(0, Math.min(...ys) - 55);
  return {
    x,
    y,
    width: Math.min(map.canvas.width, Math.max(...xs) + 55) - x,
    height: Math.min(map.canvas.height, Math.max(...ys) + 55) - y,
  };
}

export function matchesOperationalGeography(map: MapData, cities: readonly DrawnCity[]) {
  const basemap = basemapForOperationalMap(map);
  if (
    map.version !== 3 ||
    !basemap ||
    map.basemap.source !== 'natural-earth-5.1.2' ||
    map.basemap.projection !== 'WGS84 plate carree' ||
    JSON.stringify(map.basemap.bounds) !== JSON.stringify(basemap.bounds)
  )
    return false;
  const anchors = map.sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS');
  if (
    anchors.length !== cities.length ||
    new Set(map.sites.map((site) => site.id)).size !== map.sites.length ||
    new Set(anchors.map((site) => site.anchorKey)).size !== anchors.length ||
    new Set(cities.map((city) => city.key)).size !== cities.length
  )
    return false;
  return anchors.every((site) => {
    const city = cities.find((row) => row.key === site.anchorKey);
    return (
      city &&
      city.kind === site.kind &&
      city.name === site.name &&
      city.x === site.position.x &&
      city.y === site.position.y
    );
  });
}

export function OperationalWorldMap({
  cities,
  nations,
  map,
  myCityKey,
  selectedKey,
  onSelect,
  fill = false,
}: {
  cities: readonly DrawnCity[];
  nations: readonly DrawnNation[];
  map: MapData;
  myCityKey: number | null;
  selectedKey: number | null;
  onSelect?: (key: number) => void;
  /** 부모 상자를 가득 채운다(로그인 배경). 남는 가장자리는 바다색이다. */
  fill?: boolean;
}) {
  const basemap = basemapForOperationalMap(map);
  const canvas = map.canvas;
  const whole = operationalOverview(map);
  const ratio = whole.height / whole.width;
  const clampView = (value: View) => clamp(value, canvas);
  const [view, setView] = useState(whole);
  // anchor: 표식 위에서 시작한 데스크톱 누르기. 4px 넘게 움직여야 끌기로 보고 그때 포인터를 잡는다(그 전엔 클릭 선택).
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    view: View;
    mobile: boolean;
    moved: boolean;
    anchor: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const completedTap = useRef<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [layout, setLayout] = useState({ mobile: false, width: 0, height: 0 });
  const [choices, setChoices] = useState<number[]>([]);
  // 마우스로 표식 위에 올렸을 때만 보이는 툴팁. 내용은 aria-label·선택 정보와 같다(호버 전용 정보 없음).
  const [hover, setHover] = useState<{ siteId: string; x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const choiceOrigin = useRef<SVGElement | null>(null);
  const validGeography = matchesOperationalGeography(map, cities);
  const grid = useTerrainGrid(basemap?.pixels, basemap?.palette);
  const lanes = useMemo(() => (grid ? waterLanes(map, grid) : []), [grid, map]);
  const laneIds = useMemo(() => new Set(lanes.map((lane) => lane.id)), [lanes]);
  // 길은 표식에 실제로 있는 문으로만 드나든다(D-052). 문 칸은 문이 난 변까지의 반지름만큼 떨어진다.
  // 문은 도시 규모로만 정해지므로 규모가 바뀔 때만 다시 계산한다. 지도 전체 길 계산이 여기에 걸려 있다.
  const levelKey = cities.map((city) => `${city.key}:${city.level}`).join(',');
  const gateCells = useMemo(() => {
    const levels = new Map(
      levelKey ? levelKey.split(',').map((entry) => entry.split(':').map(Number) as [number, number]) : [],
    );
    const gates = new Map<string, SiteGate>(
      map.sites.map((site) => {
        const level = site.kind === 'CITY' && site.anchorKey !== undefined ? levels.get(site.anchorKey) : undefined;
        const axis = site.kind === 'PASS' ? passAxis(site.position, passNeighbours(site.id, map)) : undefined;
        const box = markerBox(site.kind, level, axis);
        const allowed = markerGates(site.kind, level, axis);
        // 관은 길 방향 변(짧은 쪽)에 문이 있다. 나머지는 정사각형이라 어느 변이든 같다.
        const toGate = allowed && allowed.every((gate) => gate === 'N' || gate === 'S') ? box.height : box.width;
        const half = { x: Math.ceil(box.width / 2 / ROAD_CELL), y: Math.ceil(box.height / 2 / ROAD_CELL) };
        return [site.id, { cells: Math.ceil(toGate / 2 / ROAD_CELL), allowed, half }];
      }),
    );
    return (siteId: string) => gates.get(siteId) ?? 0;
  }, [levelKey, map]);
  // 땅길은 확대 전후 모두 같은 가로세로 칸 길로 그린다(D-055). 지형 칸을 읽으면 산을 돌고 물을 짧게 건넌다.
  // 지형은 물길(laneIds)과 같은 때 한 번 읽히므로 길 계산이 더 늘지 않는다.
  const walks = useMemo(() => roadWalks(map, laneIds, gateCells, ROAD_CELL, grid), [map, laneIds, gateCells, grid]);
  const canSelect = Boolean(onSelect);
  useEffect(() => {
    const element = svg.current;
    if (!validGeography || !element) return;
    const read = () => {
      const box = element.getBoundingClientRect();
      const next = { mobile: window.innerWidth <= 767, width: box.width, height: box.height };
      setLayout((old) =>
        old.mobile === next.mobile && old.width === next.width && old.height === next.height ? old : next,
      );
    };
    read();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    observer?.observe(element);
    window.addEventListener('resize', read);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [validGeography]);
  // 휠 확대는 페이지 스크롤을 막아야 해서 passive가 아닌 수신기로 단다. 커서 아래 지점이 그 자리에 남는다.
  const maxWidth = whole.width;
  useEffect(() => {
    const element = svg.current;
    if (!validGeography || !element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      // 끌기는 시작할 때의 보기를 기준으로 옮긴다. 그 사이 확대하면 다음 이동이 되돌리므로 끌기 중엔 막는다.
      if (drag.current) {
        event.preventDefault();
        return;
      }
      const matrix = element.getScreenCTM?.();
      if (!matrix) return;
      event.preventDefault();
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const factor = wheelFactor(event.deltaY, event.deltaMode);
      setView((old) => clamp(zoomAround(old, factor, point.x, point.y, maxWidth, ratio), canvas));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [validGeography, maxWidth, ratio, canvas]);
  useEffect(() => {
    setChoices((old) => (old.length ? [] : old));
  }, [view.x, view.y, view.width, view.height, layout.mobile, map.id, selectedKey, canSelect]);
  useEffect(() => {
    if (choices.length) firstChoice.current?.focus();
  }, [choices]);
  useEffect(() => {
    const active = drag.current;
    drag.current = null;
    completedTap.current = null;
    if (active && svg.current?.hasPointerCapture?.(active.pointerId))
      svg.current.releasePointerCapture(active.pointerId);
  }, [layout.mobile]);
  const uid = useId().replaceAll(':', '');
  const arrowId = `operational-arrow-${uid}`;
  const flagMaskId = `operational-flag-${uid}`;
  const selectedCity = cities.find((city) => city.key === selectedKey);
  const selectedX = selectedCity?.x;
  const selectedY = selectedCity?.y;
  useEffect(() => {
    if (selectedX === undefined || selectedY === undefined) return;
    setView((old) =>
      selectedX < old.x || selectedX > old.x + old.width || selectedY < old.y || selectedY > old.y + old.height
        ? clampView({ ...old, x: selectedX - old.width / 2, y: selectedY - old.height / 2 })
        : old,
    );
  }, [selectedX, selectedY]);
  if (!validGeography || !basemap) return <p role="alert">지도 판이 맞지 않습니다. 지도를 다시 불러오세요.</p>;
  const cityByKey = new Map(cities.map((city) => [city.key, city]));
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const siteById = new Map(map.sites.map((site) => [site.id, site]));
  // 항구는 켜진 물길이 타고 내리는 자리일 때만 그린다. 물길이 없는 판(SAN10)의 항구 시설은 숨긴다.
  const usedPorts = new Set(
    map.routes.flatMap((route) => (route.enabled && route.mode === 'RIVER' ? (route.portIds ?? []) : [])),
  );
  const drawnSites = map.sites.filter((site) => site.kind !== 'PORT' || usedPorts.has(site.id));
  const anchors = map.sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS');
  const tapTargets = layout.mobile && onSelect ? mapTapTargets(cities, view, layout) : [];
  const targetByKey = new Map(tapTargets.map((target) => [target.key, target]));
  // 화면 px / 지도 단위. 크기를 아직 못 읽었으면 0이고 표식은 네모로 줄인다.
  const pixelsPerUnit =
    layout.width > 0 && layout.height > 0 ? Math.min(layout.width / view.width, layout.height / view.height) : 0;
  // 지도 요소의 화면 비율이 보기와 다르면 viewBox 바깥도 가운데 맞춤으로 보인다. 타일은 실제로 보이는 범위에 깐다.
  const shown = pixelsPerUnit
    ? {
        x: view.x - (layout.width / pixelsPerUnit - view.width) / 2,
        y: view.y - (layout.height / pixelsPerUnit - view.height) / 2,
        width: layout.width / pixelsPerUnit,
        height: layout.height / pixelsPerUnit,
      }
    : view;
  // 이름표 글자는 7단위다. 화면에서 14px보다 커지지 않게 줄인다.
  const labelScale = pixelsPerUnit > 2 ? 2 / pixelsPerUnit : 1;
  const closeChoices = (restoreFocus: boolean) => {
    setChoices([]);
    if (restoreFocus) {
      const origin = choiceOrigin.current;
      if (origin?.isConnected && svg.current?.contains(origin)) origin.focus();
      else svg.current?.focus();
    }
  };
  const zoom = (factor: number) =>
    setView((old) =>
      clampView(zoomAround(old, factor, old.x + old.width / 2, old.y + old.height / 2, whole.width, ratio)),
    );
  const choose = (key: number, focus = false) => {
    const city = cityByKey.get(key);
    if (!city || !onSelect) return;
    onSelect(key);
    if (focus)
      setView((old) => {
        const width = Math.min(old.width, 500);
        return clampView({ x: city.x - width / 2, y: city.y - (width * ratio) / 2, width, height: width * ratio });
      });
  };
  const selectAt = (element: SVGSVGElement, clientX: number, clientY: number) => {
    const matrix = element.getScreenCTM();
    if (!matrix) return;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    const keys = tapCandidates(tapTargets, point);
    if (keys.length === 1) {
      choose(keys[0]!);
      closeChoices(false);
    } else if (keys.length > 1) {
      choiceOrigin.current = element.querySelector<SVGElement>(`[data-anchor-key="${keys[0]}"]`);
      setChoices(keys);
    }
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (
      (active.mobile || active.anchor) &&
      !active.moved &&
      Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4
    )
      return;
    if (active.anchor && !active.moved) event.currentTarget.setPointerCapture(event.pointerId);
    active.moved = true;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    // 화면 비율이 보기와 달라도(가득 채우기) 손가락 아래 지점이 따라오도록 실제 px/단위로 옮긴다.
    const perUnit = Math.min(box.width / active.view.width, box.height / active.view.height);
    setView(
      clampView({
        ...active.view,
        x: active.view.x - (event.clientX - active.x) / perUnit,
        y: active.view.y - (event.clientY - active.y) / perUnit,
      }),
    );
  };
  return (
    <div
      ref={frame}
      className={fill ? `${styles.frame} ${styles.fill}` : styles.frame}
      data-testid="operational-world-map"
      onPointerDownCapture={() => {
        completedTap.current = null;
        suppressClick.current = false;
      }}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          layout.mobile &&
          completedTap.current !== null &&
          (event.nativeEvent as globalThis.PointerEvent).pointerId === completedTap.current
        ) {
          completedTap.current = null;
          event.preventDefault();
          event.stopPropagation();
          firstChoice.current?.focus();
        }
      }}
    >
      <div className={styles.controls}>
        <div className={styles.zoom} role="group" aria-label="지도 배율">
          <button
            type="button"
            aria-label="지도 확대"
            disabled={view.width <= MIN_VIEW_WIDTH}
            onClick={() => zoom(1.5)}
          >
            확대
          </button>
          <button
            type="button"
            aria-label="지도 축소"
            disabled={view.width >= whole.width}
            onClick={() => zoom(1 / 1.5)}
          >
            축소
          </button>
          <button type="button" aria-label="지도 전체" onClick={() => setView(whole)}>
            전체
          </button>
          <output aria-label="현재 지도 배율">{(whole.width / view.width).toFixed(1)}배</output>
        </div>
        {onSelect && (
          <label className={styles.selector}>
            지도 거점
            <select
              value={selectedKey ?? ''}
              onChange={(event) => choose(Number(event.target.value), map.id !== 'san10')}
            >
              <option value="" disabled>
                도시·관문 선택
              </option>
              {anchors.map((site) => (
                <option key={site.id} value={site.anchorKey}>
                  {site.name} ({labels[site.kind]})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        className={fill ? `${styles.map} ${styles.mapFill}` : styles.map}
        style={fill ? undefined : { aspectRatio: `${whole.width}/${whole.height}` }}
        role="group"
        aria-label={`중원 지도, 도시 ${anchors.filter((site) => site.kind === 'CITY').length}개, 관문 ${anchors.filter((site) => site.kind === 'PASS').length}개`}
        data-testid="world-map"
        tabIndex={0}
        onKeyDown={(event) => {
          const direction = (
            { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>
          )[event.key];
          if (direction) {
            event.preventDefault();
            setView((old) =>
              clampView({
                ...old,
                x: old.x + (direction[0]! * old.width) / 5,
                y: old.y + (direction[1]! * old.height) / 5,
              }),
            );
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            zoom(1.5);
          } else if (event.key === '-') {
            event.preventDefault();
            zoom(1 / 1.5);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false || drag.current) return;
          // 크게 확대하면 표식이 화면을 덮는다. 표식 위에서도 끌 수 있게 하되 움직이기 전까지는 클릭으로 둔다.
          const anchor =
            !layout.mobile && event.target instanceof Element && event.target.closest('[data-anchor-key]') !== null;
          setHover(null);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            view,
            mobile: layout.mobile,
            moved: false,
            anchor,
          };
          if (!anchor) event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          const active = drag.current;
          if (!active || active.pointerId !== event.pointerId) return;
          drag.current = null;
          // 표식 위에서 끌고 놓으면 뒤따르는 클릭이 선택으로 번지지 않게 한 번 막는다.
          if (active.anchor && active.moved) suppressClick.current = true;
          if (active.mobile) {
            completedTap.current = event.pointerId;
            if (!active.moved) selectAt(event.currentTarget, event.clientX, event.clientY);
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerLeave={(event) => {
          // 표식 위 누르기는 움직이기 전엔 포인터를 잡지 않는다. 그 사이 지도 밖에서 놓으면 pointerup이 오지 않으니 여기서 푼다.
          const active = drag.current;
          if (active?.pointerId === event.pointerId && active.anchor && !active.moved) drag.current = null;
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
        }}
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10" fill="context-stroke" />
          </marker>
          <FlagMaskDef id={flagMaskId} />
        </defs>
        <rect width={canvas.width} height={canvas.height} fill="#2b4a6b" />
        <g aria-hidden="true" pointerEvents="none" data-testid="geographic-basemap">
          <image
            href={basemap.pixels}
            width={canvas.width}
            height={canvas.height}
            preserveAspectRatio="none"
            style={{ imageRendering: 'pixelated' }}
            data-testid="geographic-relief"
          />
        </g>
        {grid && showTiles(pixelsPerUnit) && (
          <TerrainTileLayer grid={grid} walks={walks} view={shown} idPrefix={`operational-terrain-${uid}`} />
        )}
        <RoadPixelLayer
          map={map}
          skip={laneIds}
          walks={walks}
          modes={grid && showTiles(pixelsPerUnit) ? ['FORD', 'RIVER'] : undefined}
        />
        <WaterLaneLayer lanes={lanes} />
        <g aria-hidden="true" pointerEvents="none">
          {map.routes
            .filter((route) => route.enabled)
            .map((route) => {
              const ids = [
                route.from,
                ...(route.mode === 'RIVER' && route.portIds ? [route.portIds[0]] : []),
                ...(route.via ?? []),
                ...(route.mode === 'RIVER' && route.portIds ? [route.portIds[1]] : []),
                route.to,
              ];
              // 칸 길이 있는 경로는 일방통행 선·화살표도 그 길 칸 가운데를 따른다(D-055).
              const walk = walks.get(route.id);
              const points = walk
                ? walk.map((cell) => ({ x: (cell.x + 0.5) * ROAD_CELL, y: (cell.y + 0.5) * ROAD_CELL }))
                : ids.map((id) => siteById.get(id)?.position);
              if (points.some((point) => point === undefined)) return null;
              return (
                <polyline
                  key={route.id}
                  data-route-mode={route.mode}
                  className={`${styles.route} ${route.direction === 'FORWARD' ? styles.oneWay : ''}`}
                  points={points.map((point) => `${point!.x},${point!.y}`).join(' ')}
                  markerEnd={route.direction === 'FORWARD' ? `url(#${arrowId})` : undefined}
                />
              );
            })}
        </g>
        {drawnSites.map((site) => {
          const city = site.anchorKey === undefined ? undefined : cityByKey.get(site.anchorKey);
          const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
          const mine = city?.key === myCityKey;
          const selected = city?.key === selectedKey;
          const parent = site.kind === 'PORT' ? siteById.get(site.parentCityId!) : undefined;
          const grade = site.kind === 'CITY' ? levelName(city?.level) : undefined;
          const capital = city !== undefined && isCapital(city, nation);
          const plate = capital ? `${CAPITAL_MARK}${site.name}` : site.name;
          const label = [
            site.name,
            grade ? `${grade} ${labels[site.kind]}` : labels[site.kind],
            city?.recorded === false ? '기록 없음' : (nation?.name ?? (city ? '공백지' : null)),
            capital ? '수도' : null,
            parent ? `${parent.name} 소속` : null,
            mine ? '내 위치' : null,
            city?.supplied === false && city.nationId !== null ? '보급 끊김' : null,
          ]
            .filter(Boolean)
            .join(', ');
          const action = city && onSelect ? () => choose(city.key) : undefined;
          const target = city ? targetByKey.get(city.key) : undefined;
          const level = site.kind === 'CITY' ? city?.level : undefined;
          const axis = site.kind === 'PASS' ? passAxis(site.position, passNeighbours(site.id, map)) : undefined;
          const radius = markerUnits(site.kind, level) / 2;
          // 이름표는 그림 아래 변 바로 밑에 단다. 가로 성벽 관은 그림이 낮아 더 붙는다.
          const below = markerBox(site.kind, level, axis).height / 2;
          return (
            <g
              key={site.id}
              role={action ? 'button' : 'img'}
              tabIndex={action ? (layout.mobile && !target ? -1 : 0) : undefined}
              aria-label={label}
              aria-pressed={action ? selected : undefined}
              data-anchor-key={city?.key}
              data-site-kind={site.kind}
              data-city-key={city?.key}
              data-nation-id={city?.nationId ?? ''}
              data-mine={mine || undefined}
              data-selected={selected || undefined}
              className={action ? styles.anchor : styles.display}
              onPointerMove={(event) => {
                if (event.pointerType !== 'mouse' || drag.current) return;
                const box = frame.current?.getBoundingClientRect();
                if (box) setHover({ siteId: site.id, x: event.clientX - box.left, y: event.clientY - box.top });
              }}
              onPointerLeave={() => setHover((old) => (old?.siteId === site.id ? null : old))}
              onClick={
                action
                  ? (event) => {
                      if (!layout.mobile || event.detail === 0) action();
                    }
                  : undefined
              }
              onKeyDown={
                action
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        event.stopPropagation();
                        action();
                      }
                    }
                  : undefined
              }
            >
              {target ? (
                <rect
                  data-testid="map-tap-target"
                  data-tap-key={target.key}
                  x={target.x}
                  y={target.y}
                  width={target.width}
                  height={target.height}
                  fill="transparent"
                  pointerEvents="all"
                />
              ) : null}
              {city?.recorded === false && (
                <circle className={styles.unrecorded} cx={site.position.x} cy={site.position.y} r={radius + 2} />
              )}
              {action && (
                <circle className={styles.focusRing} cx={site.position.x} cy={site.position.y} r={radius + 3} />
              )}
              {mine && <circle cx={site.position.x} cy={site.position.y} r={radius + 6} className={styles.mine} />}
              {selected && (
                <circle cx={site.position.x} cy={site.position.y} r={radius + 4} className={styles.selected} />
              )}
              <g data-testid={`site-icon-${site.kind.toLowerCase()}`}>
                <MapSiteMarker
                  x={site.position.x}
                  y={site.position.y}
                  kind={site.kind}
                  level={site.kind === 'CITY' ? city?.level : undefined}
                  axis={axis}
                  color={city && city.recorded !== false ? (nation?.color ?? null) : null}
                  pixelsPerUnit={pixelsPerUnit}
                  flagMaskId={flagMaskId}
                />
              </g>
              <g transform={`translate(${site.position.x} ${site.position.y + below + 2}) scale(${labelScale})`}>
                <rect
                  x={-(Array.from(plate).length * 6 + 5) / 2}
                  y={0}
                  width={Array.from(plate).length * 6 + 5}
                  height="11"
                  rx="1"
                  fill={nation?.color ?? '#eee8d7'}
                />
                <text x={0} y={8} className={styles.label} fill={nation ? readableTextColor(nation.color) : '#282d29'}>
                  {plate}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
      {hover
        ? (() => {
            const site = siteById.get(hover.siteId);
            if (!site) return null;
            const city = site.anchorKey === undefined ? undefined : cityByKey.get(site.anchorKey);
            const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
            const parent = site.kind === 'PORT' ? siteById.get(site.parentCityId!) : undefined;
            const grade = site.kind === 'CITY' ? levelName(city?.level) : undefined;
            const owner = city?.recorded === false ? '기록 없음' : (nation?.name ?? (city ? '공백지' : null));
            const notes = [
              city && isCapital(city, nation) ? '수도' : null,
              parent ? `${parent.name} 소속` : null,
              city?.key === myCityKey ? '내 위치' : null,
              city?.supplied === false && city.nationId !== null ? '보급 끊김' : null,
            ].filter((note): note is string => note !== null);
            // 커서 오른쪽 아래에 띄우되 지도 밖으로 나가면 왼쪽·위로 넘긴다.
            const right = hover.x > layout.width - 200;
            const below = hover.y < 120;
            return (
              <div
                className={styles.tooltip}
                data-testid="map-tooltip"
                aria-hidden="true"
                style={{
                  left: right ? undefined : hover.x + 14,
                  right: right ? Math.max(0, layout.width - hover.x + 14) : undefined,
                  top: below ? hover.y + 18 : undefined,
                  bottom: below ? undefined : Math.max(0, (frame.current?.clientHeight ?? 0) - hover.y + 10),
                }}
              >
                <p className={styles.tooltipTitle}>
                  <span>{site.name}</span>
                  <span className={styles.tooltipGrade}>{grade ?? shortLabels[site.kind]}</span>
                </p>
                {owner ? (
                  <p className={styles.tooltipOwner}>
                    <span className={styles.tooltipSwatch} style={{ background: nation?.color ?? '#d6d0c4' }} />
                    {owner}
                  </p>
                ) : null}
                {notes.map((note) => (
                  <p key={note} className={styles.tooltipNote}>
                    {note}
                  </p>
                ))}
              </div>
            );
          })()
        : null}
      {onSelect && layout.mobile && choices.length > 1 ? (
        <div
          className={styles.choices}
          role="group"
          aria-label="겹친 거점 선택"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              closeChoices(true);
            }
          }}
        >
          <p>거점이 가까이 있습니다. 살펴볼 거점을 고르세요.</p>
          <div>
            {choices.map((key, index) => {
              const site = anchors.find((entry) => entry.anchorKey === key);
              return site ? (
                <button
                  key={key}
                  ref={index === 0 ? firstChoice : undefined}
                  type="button"
                  onClick={() => {
                    choose(key);
                    closeChoices(false);
                    svg.current?.querySelector<SVGElement>(`[data-anchor-key="${key}"]`)?.focus();
                  }}
                >
                  {site.name} ({labels[site.kind]})
                </button>
              ) : null;
            })}
            <button type="button" onClick={() => closeChoices(true)}>
              선택 취소
            </button>
          </div>
        </div>
      ) : null}
      <p className={styles.help}>
        드래그나 방향키로 이동 · 확대 뒤 도시·관문 선택 · 항구는 도시 시설 · 전장은 지명 표시
      </p>
    </div>
  );
}
