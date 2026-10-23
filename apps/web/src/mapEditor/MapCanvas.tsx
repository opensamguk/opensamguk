import { useEffect, useRef, useState, type Dispatch, type PointerEvent } from 'react';
import { cityRadius, mapLinks } from '../main/WorldMap';
import {
  isClosedPolygon,
  SKETCH,
  SKETCH_PALETTE,
  TERRAIN_LAYERS,
  type MapV2,
  type Point,
  type TerrainLayer,
} from './contract';
import { moveCity, moveTerrainPoint, type EditorAction, type Selection } from './editor';
import styles from './MapEditor.module.css';
import { sketchBackground } from './sketch';

export type Tool = 'select' | 'city' | 'link' | TerrainLayer;

export interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_ZOOM = 8;
export const fullView = (map: MapV2): View => ({ x: 0, y: 0, w: map.canvas.width, h: map.canvas.height });

// 1배(전체)부터 8배까지. 한가운데가 캔버스를 벗어나지 않게 둔다.
export function zoomView(
  map: MapV2,
  view: View,
  factor: number,
  cx = view.x + view.w / 2,
  cy = view.y + view.h / 2,
): View {
  const { width, height } = map.canvas;
  const w = Math.min(width, Math.max(width / MAX_ZOOM, view.w / factor));
  const h = (w * height) / width;
  return clampView(map, { x: cx - ((cx - view.x) * w) / view.w, y: cy - ((cy - view.y) * h) / view.h, w, h });
}

export function clampView(map: MapV2, view: View): View {
  const { width, height } = map.canvas;
  return {
    ...view,
    x: Math.min(Math.max(0, width - view.w), Math.max(0, view.x)),
    y: Math.min(Math.max(0, height - view.h), Math.max(0, view.y)),
  };
}

type Gesture =
  | { kind: 'city'; index: number; startX: number; startY: number; moved: boolean }
  | {
      kind: 'vertex';
      layer: TerrainLayer;
      index: number;
      point: number;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      kind: 'pan';
      shape: { layer: TerrainLayer; index: number } | null;
      startX: number;
      startY: number;
      startView: View;
      moved: boolean;
    };

type Drag =
  | { kind: 'city'; index: number; x: number; y: number }
  | { kind: 'vertex'; layer: TerrainLayer; index: number; point: number; x: number; y: number };

const DRAG_THRESHOLD = 3;
const layerColor: Record<TerrainLayer, string> = {
  coast: SKETCH_PALETTE[SKETCH.land].color,
  lakes: SKETCH_PALETTE[SKETCH.lake].color,
  mountains: SKETCH_PALETTE[SKETCH.mountain].color,
  rivers: SKETCH_PALETTE[SKETCH.river].color,
};
const pointsAttr = (points: readonly Point[]) => points.map(([x, y]) => `${x},${y}`).join(' ');

function readTarget(element: Element | null) {
  const vertex = element?.closest<SVGElement>('[data-vertex]');
  if (vertex) return { kind: 'vertex' as const, point: Number(vertex.dataset.vertex) };
  const city = element?.closest<SVGElement>('[data-city-index]');
  if (city) return { kind: 'city' as const, index: Number(city.dataset.cityIndex) };
  const shape = element?.closest<SVGElement>('[data-shape-layer]');
  if (shape)
    return {
      kind: 'shape' as const,
      layer: shape.dataset.shapeLayer as TerrainLayer,
      index: Number(shape.dataset.shapeIndex),
    };
  return { kind: 'background' as const };
}

// 편집 캔버스. 좌표계는 메인 지도(WorldMap.tsx)와 같고 연결선과 도시 점 크기도 같은 함수로 그린다.
// 끌기는 놓을 때 편집 하나로 보낸다. 끄는 동안에는 이 부품 안에서만 미리 그린다.
export function MapCanvas({
  map,
  selection,
  tool,
  drawing,
  linkFrom,
  view,
  dispatch,
  onView,
  onAddPoint,
  onLinkClick,
}: {
  map: MapV2;
  selection: Selection | null;
  tool: Tool;
  drawing: Point[];
  linkFrom: number | null;
  view: View;
  dispatch: Dispatch<EditorAction>;
  onView: (view: View) => void;
  onAddPoint: (x: number, y: number) => void;
  onLinkClick: (index: number | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const zoom = map.canvas.width / view.w;

  const toMap = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return [0, 0];
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return [p.x, p.y];
  };

  // 휠 확대는 기본 스크롤을 막아야 해서 passive가 아닌 수신기로 단다.
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const [cx, cy] = toMap(event.clientX, event.clientY);
      onView(zoomView(map, viewRef.current, event.deltaY < 0 ? 1.25 : 0.8, cx, cy));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  });

  const selectedLine = selection?.kind === 'terrain' ? { layer: selection.layer, index: selection.index } : null;

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const target = readTarget(event.target as Element);
    const [x, y] = toMap(event.clientX, event.clientY);
    const start = { startX: event.clientX, startY: event.clientY, moved: false };
    if (tool === 'select') {
      if (target.kind === 'vertex' && selectedLine)
        gesture.current = { kind: 'vertex', ...selectedLine, point: target.point, ...start };
      else if (target.kind === 'city') gesture.current = { kind: 'city', index: target.index, ...start };
      else
        gesture.current = {
          kind: 'pan',
          shape: target.kind === 'shape' ? { layer: target.layer, index: target.index } : null,
          startView: view,
          ...start,
        };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'city') {
      if (target.kind === 'city') dispatch({ type: 'select', selection: { kind: 'city', index: target.index } });
      else dispatch({ type: 'addCity', x, y });
      return;
    }
    if (tool === 'link') {
      onLinkClick(target.kind === 'city' ? target.index : null);
      return;
    }
    onAddPoint(x, y);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.moved && Math.hypot(event.clientX - g.startX, event.clientY - g.startY) < DRAG_THRESHOLD) return;
    g.moved = true;
    if (g.kind === 'pan') {
      const rect = event.currentTarget.getBoundingClientRect();
      const perPixel = g.startView.w / rect.width;
      onView(
        clampView(map, {
          ...g.startView,
          x: g.startView.x - (event.clientX - g.startX) * perPixel,
          y: g.startView.y - (event.clientY - g.startY) * perPixel,
        }),
      );
      return;
    }
    const [x, y] = toMap(event.clientX, event.clientY);
    setDrag(g.kind === 'city' ? { kind: 'city', index: g.index, x, y } : { ...g, kind: 'vertex', x, y });
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setDrag(null);
    if (!g) return;
    const [x, y] = toMap(event.clientX, event.clientY);
    if (g.kind === 'city') {
      if (g.moved) dispatch({ type: 'moveCity', index: g.index, x, y });
      else dispatch({ type: 'select', selection: { kind: 'city', index: g.index } });
    } else if (g.kind === 'vertex') {
      if (g.moved) dispatch({ type: 'moveTerrainPoint', layer: g.layer, index: g.index, point: g.point, x, y });
      else dispatch({ type: 'select', selection: { kind: 'terrain', layer: g.layer, index: g.index, point: g.point } });
    } else if (!g.moved) {
      dispatch({ type: 'select', selection: g.shape ? { kind: 'terrain', ...g.shape, point: null } : null });
    }
  };

  const shown =
    drag?.kind === 'city'
      ? moveCity(map, drag.index, drag.x, drag.y)
      : drag?.kind === 'vertex'
        ? moveTerrainPoint(map, drag.layer, drag.index, drag.point, drag.x, drag.y)
        : map;
  const nodes = shown.cities.map((city, index) => ({ key: city.id, links: city.connections, index, city }));
  const handle = 4 / zoom;
  const isSelectedLine = (layer: TerrainLayer, index: number) =>
    selectedLine?.layer === layer && selectedLine.index === index;
  const selectedPoints =
    selectedLine === null
      ? null
      : selectedLine.layer === 'rivers'
        ? shown.terrain.rivers[selectedLine.index]?.points
        : shown.terrain[selectedLine.layer][selectedLine.index];

  return (
    <svg
      ref={svgRef}
      className={styles.canvas}
      style={{ aspectRatio: `${map.canvas.width} / ${map.canvas.height}` }}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      role="application"
      aria-label={`편집 캔버스, 도시 ${map.cities.length}개`}
      data-testid="map-editor-canvas"
      data-tool={tool}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        gesture.current = null;
        setDrag(null);
      }}
    >
      <rect
        width={map.canvas.width}
        height={map.canvas.height}
        className={styles.ground}
        style={{ fill: SKETCH_PALETTE[sketchBackground(shown)].color }}
      />
      {TERRAIN_LAYERS.map(({ layer, closed }) => (
        <g key={layer} data-layer={layer}>
          {(layer === 'rivers' ? shown.terrain.rivers.map((river) => river.points) : shown.terrain[layer]).map(
            (points, index) => {
              const selected = isSelectedLine(layer, index);
              const common = {
                'data-shape-layer': layer,
                'data-shape-index': index,
                className: selected ? `${styles.shape} ${styles.shapeSelected}` : styles.shape,
              };
              if (!closed)
                return (
                  <g key={index} {...common}>
                    <polyline className={styles.riverHit} points={pointsAttr(points)} />
                    <polyline
                      className={styles.river}
                      points={pointsAttr(points)}
                      style={{ stroke: layerColor[layer] }}
                    />
                  </g>
                );
              // 열린 다각형은 채우지 않고 점선으로 그려 눈에 띄게 한다.
              return isClosedPolygon(points) ? (
                <polygon key={index} {...common} points={pointsAttr(points)} style={{ fill: layerColor[layer] }} />
              ) : (
                <polyline
                  key={index}
                  {...common}
                  className={`${common.className} ${styles.openShape}`}
                  points={pointsAttr(points)}
                />
              );
            },
          )}
        </g>
      ))}
      <g aria-hidden="true">
        {mapLinks(nodes).map(([a, b]) => (
          <line
            key={`${a.key}-${b.key}`}
            className={styles.link}
            x1={a.city.position.x}
            y1={a.city.position.y}
            x2={b.city.position.x}
            y2={b.city.position.y}
          />
        ))}
      </g>
      {nodes.map(({ city, index }) => {
        const r = cityRadius(city.level);
        const selected = selection?.kind === 'city' && selection.index === index;
        return (
          <g
            key={index}
            className={styles.city}
            data-city-index={index}
            data-city-id={city.id}
            data-selected={selected || undefined}
            data-link-from={linkFrom === index || undefined}
          >
            {selected || linkFrom === index ? (
              <circle
                className={linkFrom === index ? styles.linkFrom : styles.selected}
                cx={city.position.x}
                cy={city.position.y}
                r={r + 3}
              />
            ) : null}
            <circle className={styles.dot} cx={city.position.x} cy={city.position.y} r={r} />
            <text className={styles.label} x={city.position.x} y={city.position.y + r + 10}>
              {city.name}
            </text>
          </g>
        );
      })}
      {selectedPoints && selectedLine
        ? (selectedLine.layer !== 'rivers' && isClosedPolygon(selectedPoints)
            ? selectedPoints.slice(0, -1)
            : selectedPoints
          ).map(([x, y], point) => (
            <rect
              key={point}
              data-vertex={point}
              className={
                selection?.kind === 'terrain' && selection.point === point
                  ? `${styles.vertex} ${styles.vertexSelected}`
                  : styles.vertex
              }
              x={x - handle}
              y={y - handle}
              width={handle * 2}
              height={handle * 2}
            />
          ))
        : null}
      {drawing.length > 0 ? (
        <g className={styles.drawing} aria-hidden="true">
          <polyline points={pointsAttr(drawing)} />
          {drawing.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={handle} />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
