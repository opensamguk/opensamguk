import type { PublicGeography } from '@opensamguk/shared';
import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import type { MapCity, MapNation } from '../game/types';
import { readableTextColor } from '../ui/color';
import reliefUrl from '../mapEditor/geodata/natural-earth-relief.webp';
import cityIcon from '../mapEditor/icons/city.png';
import passIcon from '../mapEditor/icons/pass.png';
import portIcon from '../mapEditor/icons/port.png';
import fieldIcon from '../mapEditor/icons/field.png';
import { basemapForOperationalMap } from './operationalGeography';
import { mapTapTargets, tapCandidates, type MapView } from './mapTapTargets';
import styles from './OperationalWorldMap.module.css';

type MapData = PublicGeography;
type DrawnCity = Pick<MapCity, 'key' | 'name' | 'kind' | 'x' | 'y' | 'nationId'> & {
  supplied?: boolean;
  recorded?: boolean;
};
type View = MapView;
const icons = { CITY: cityIcon, PASS: passIcon, PORT: portIcon, FIELD: fieldIcon };
const labels = { CITY: '도시', PASS: '관문', PORT: '항구 시설', FIELD: '전장 표시' };
const neutral = '#d6d0c4';
const clamp = (view: View, canvas: MapData['canvas']): View => ({
  ...view,
  x: Math.max(0, Math.min(canvas.width - view.width, view.x)),
  y: Math.max(0, Math.min(canvas.height - view.height, view.y)),
});

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
}: {
  cities: readonly DrawnCity[];
  nations: readonly MapNation[];
  map: MapData;
  myCityKey: number | null;
  selectedKey: number | null;
  onSelect?: (key: number) => void;
}) {
  const basemap = basemapForOperationalMap(map);
  const canvas = map.canvas;
  const whole = operationalOverview(map);
  const ratio = whole.height / whole.width;
  const clampView = (value: View) => clamp(value, canvas);
  const [view, setView] = useState(whole);
  const drag = useRef<{ pointerId: number; x: number; y: number; view: View; mobile: boolean; moved: boolean } | null>(
    null,
  );
  const completedTap = useRef<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [layout, setLayout] = useState({ mobile: false, width: 0, height: 0 });
  const [choices, setChoices] = useState<number[]>([]);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const choiceOrigin = useRef<SVGElement | null>(null);
  const validGeography = matchesOperationalGeography(map, cities);
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
  const arrowId = `operational-arrow-${useId().replaceAll(':', '')}`;
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
  const anchors = map.sites.filter((site) => site.kind === 'CITY' || site.kind === 'PASS');
  const tapTargets = layout.mobile && onSelect ? mapTapTargets(cities, view, layout) : [];
  const targetByKey = new Map(tapTargets.map((target) => [target.key, target]));
  const closeChoices = (restoreFocus: boolean) => {
    setChoices([]);
    if (restoreFocus) {
      const origin = choiceOrigin.current;
      if (origin?.isConnected && svg.current?.contains(origin)) origin.focus();
      else svg.current?.focus();
    }
  };
  const zoom = (factor: number) =>
    setView((old) => {
      const width = Math.min(whole.width, Math.max(200, old.width / factor));
      const height = width * ratio;
      return clampView({ x: old.x + (old.width - width) / 2, y: old.y + (old.height - height) / 2, width, height });
    });
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
    if (active.mobile && !active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4) return;
    active.moved = true;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    setView(
      clampView({
        ...active.view,
        x: active.view.x - ((event.clientX - active.x) * active.view.width) / box.width,
        y: active.view.y - ((event.clientY - active.y) * active.view.height) / box.height,
      }),
    );
  };
  return (
    <div
      className={styles.frame}
      data-testid="operational-world-map"
      onPointerDownCapture={() => {
        completedTap.current = null;
      }}
      onClickCapture={(event) => {
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
          <button type="button" aria-label="지도 확대" disabled={view.width <= 200} onClick={() => zoom(1.5)}>
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
        className={styles.map}
        style={{ aspectRatio: `${whole.width}/${whole.height}` }}
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
          if (
            event.button !== 0 ||
            event.isPrimary === false ||
            drag.current ||
            (!layout.mobile && event.target instanceof Element && event.target.closest('[data-anchor-key]'))
          )
            return;
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            view,
            mobile: layout.mobile,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={(event) => {
          const active = drag.current;
          if (!active || active.pointerId !== event.pointerId) return;
          drag.current = null;
          if (active.mobile) {
            completedTap.current = event.pointerId;
            if (!active.moved) selectAt(event.currentTarget, event.clientX, event.clientY);
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
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
        </defs>
        <rect width={canvas.width} height={canvas.height} fill="#d5e5e7" />
        <g aria-hidden="true" pointerEvents="none" data-testid="geographic-basemap">
          {basemap.relief && (
            <image
              href={reliefUrl}
              width="1000"
              height="700"
              preserveAspectRatio="none"
              data-testid="geographic-relief"
            />
          )}
          {basemap.land.map((d, i) => (
            <path
              key={`land-${i}`}
              d={d}
              fill={basemap.relief ? 'none' : '#c8d0b5'}
              stroke="#8e9c8d"
              strokeWidth=".4"
              fillRule="evenodd"
            />
          ))}
          {basemap.lakes.map((d, i) => (
            <path key={`lake-${i}`} d={d} fill="#a9c9d2" stroke="#8ab0bc" strokeWidth=".3" fillRule="evenodd" />
          ))}
          {basemap.rivers.map((river, i) => (
            <path
              key={`river-${i}`}
              d={river.path}
              fill="none"
              stroke="#6d9dad"
              strokeWidth={river.rank <= 3 ? 1.15 : 0.55}
            />
          ))}
        </g>
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
              const points = ids.map((id) => siteById.get(id)?.position);
              if (points.some((point) => point === undefined)) return null;
              return (
                <polyline
                  key={route.id}
                  data-route-mode={route.mode}
                  className={`${styles.route} ${styles[route.mode.toLowerCase()] ?? ''}`}
                  points={points.map((point) => `${point!.x},${point!.y}`).join(' ')}
                  markerEnd={route.direction === 'FORWARD' ? `url(#${arrowId})` : undefined}
                />
              );
            })}
        </g>
        {map.sites.map((site) => {
          const city = site.anchorKey === undefined ? undefined : cityByKey.get(site.anchorKey);
          const nation = city?.nationId == null ? undefined : nationById.get(city.nationId);
          const mine = city?.key === myCityKey;
          const selected = city?.key === selectedKey;
          const parent = site.kind === 'PORT' ? siteById.get(site.parentCityId!) : undefined;
          const label = [
            site.name,
            labels[site.kind],
            city?.recorded === false ? '기록 없음' : (nation?.name ?? (city ? '공백지' : null)),
            parent ? `${parent.name} 소속` : null,
            mine ? '내 위치' : null,
            city?.supplied === false && city.nationId !== null ? '보급 끊김' : null,
          ]
            .filter(Boolean)
            .join(', ');
          const action = city && onSelect ? () => choose(city.key) : undefined;
          const target = city ? targetByKey.get(city.key) : undefined;
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
              <title>{label}</title>
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
              {city && (
                <circle
                  className={styles.nation}
                  cx={site.position.x}
                  cy={site.position.y}
                  r={13}
                  style={{
                    fill: city.recorded === false ? 'none' : (nation?.color ?? neutral),
                    strokeDasharray: city.recorded === false ? '3 2' : undefined,
                  }}
                />
              )}
              {mine && <circle cx={site.position.x} cy={site.position.y} r={18} className={styles.mine} />}
              {selected && <circle cx={site.position.x} cy={site.position.y} r={16} className={styles.selected} />}
              <image
                data-testid={`site-icon-${site.kind.toLowerCase()}`}
                href={icons[site.kind]}
                x={site.position.x - 8}
                y={site.position.y - 8}
                width="16"
                height="16"
                className={styles.icon}
              />
              <rect
                x={site.position.x - (Array.from(site.name).length * 6 + 5) / 2}
                y={site.position.y + 14}
                width={Array.from(site.name).length * 6 + 5}
                height="11"
                rx="1"
                fill={nation?.color ?? '#eee8d7'}
              />
              <text
                x={site.position.x}
                y={site.position.y + 22}
                className={styles.label}
                fill={nation ? readableTextColor(nation.color) : '#282d29'}
              >
                {site.name}
              </text>
            </g>
          );
        })}
      </svg>
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
