// 도식 축소 지도 (D-101, D-102). 그림 지도 대신 세력색 칸과 길 선으로 그린다. 대상 도시 고르기와 전체 축소에 쓴다.
// 후보만 밝히고 나머지는 흐리게 둔다. 현(단계 2)은 거점(큰 도시) 칸 옆 "+N"으로 접고, 그 칸을 누르면 딸린 현 펼침판이 열린다.
// 부모와 주인이 다른 현(이반 현)은 묶지 않고 따로 그린다.
import { useMemo, useState, type KeyboardEvent } from 'react';
import styles from './SchematicMap.module.css';

export interface SchematicCity {
  key: number;
  name: string;
  level: number;
  x: number;
  y: number;
  nationId: number | null;
  links: readonly number[];
  region?: number | undefined;
  /** 관(PASS)은 성문 칸, 진(FIELD)은 깃발 표식으로 그린다. 없으면 도시다. */
  kind?: string | undefined;
  /** 서버가 정한 부모 큰 도시(D-102). 없으면 같은 군의 가장 가까운 큰 도시로 묶는다. */
  parentCityKey?: number | null | undefined;
}

export interface SchematicNation {
  id: number;
  name: string;
  color: string;
  capitalCityKey?: number | null | undefined;
}

export type RouteMode = 'LAND' | 'RIVER' | 'SEA' | 'FORD' | 'BRIDGE';

const COUNTY = 2;
const ROUTE_COLOR: Record<RouteMode, string> = {
  LAND: '#c9b48a',
  RIVER: '#5f9fc4',
  SEA: '#2f5f8f',
  FORD: '#8fc0d0',
  BRIDGE: '#a0784a',
};

const isCounty = (city: SchematicCity) => city.level === COUNTY && (city.kind ?? 'CITY') === 'CITY';
const isMajor = (city: SchematicCity) => city.level >= 5;

/** 현마다 부모 큰 도시. 서버 값이 있으면 쓰고, 없으면 같은 군(없으면 전체)의 가장 가까운 큰 도시다. 동률은 키 순. */
export function countyParents(cities: readonly SchematicCity[]): Map<number, number> {
  const majors = cities.filter(isMajor);
  const parents = new Map<number, number>();
  for (const city of cities.filter(isCounty)) {
    if (city.parentCityKey != null) {
      parents.set(city.key, city.parentCityKey);
      continue;
    }
    const sameRegion = majors.filter((major) => city.region !== undefined && major.region === city.region);
    const pool = sameRegion.length > 0 ? sameRegion : majors;
    let best: SchematicCity | null = null;
    let bestDistance = Infinity;
    for (const major of pool) {
      const distance = (major.x - city.x) ** 2 + (major.y - city.y) ** 2;
      if (distance < bestDistance || (distance === bestDistance && best && major.key < best.key)) {
        best = major;
        bestDistance = distance;
      }
    }
    if (best) parents.set(city.key, best.key);
  }
  return parents;
}

export function SchematicMap({
  cities,
  nations,
  candidates,
  value,
  here,
  routeModes,
  path,
  onPick,
  label,
  compact = false,
}: {
  cities: readonly SchematicCity[];
  nations: readonly SchematicNation[];
  /** 고를 수 있는 거점. null이면 모두 고를 수 있다. */
  candidates: ReadonlySet<number> | null;
  value: number | null;
  here: number | null;
  /** 두 도시 키를 '작은-큰'으로 이은 길 종류. 없으면 육로로 그린다. */
  routeModes?: ReadonlyMap<string, RouteMode> | undefined;
  /** 고른 목적지까지의 경로(D-103). 묶인 현은 부모 칸 자리로 그린다. */
  path?: readonly number[] | undefined;
  onPick: (key: number) => void;
  label: string;
  /** 게임 화면 왼쪽 위 축소 지도(D-101, D-106): 이름, 전체 보기 단추, 범례를 빼고 여백을 줄여 칸과 길만 꽉 채운다. */
  compact?: boolean;
}) {
  const [opened, setOpened] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const byKey = useMemo(() => new Map(cities.map((city) => [city.key, city])), [cities]);
  const nationById = useMemo(() => new Map(nations.map((nation) => [nation.id, nation])), [nations]);
  const parents = useMemo(() => countyParents(cities), [cities]);
  const pickable = (key: number) => candidates === null || candidates.has(key);

  // 이반 현: 부모와 주인이 다르면 따로 그린다.
  const detached = (city: SchematicCity) => {
    const parent = byKey.get(parents.get(city.key) ?? -1);
    return parent !== undefined && parent.nationId !== city.nationId;
  };
  const visible = cities.filter((city) => !isCounty(city) || detached(city) || !parents.has(city.key));
  const clusters = useMemo(() => {
    const out = new Map<number, SchematicCity[]>();
    for (const city of cities) {
      if (!isCounty(city)) continue;
      const parentKey = parents.get(city.key);
      const parent = parentKey === undefined ? undefined : byKey.get(parentKey);
      if (!parent || parent.nationId !== city.nationId) continue;
      out.set(parent.key, [...(out.get(parent.key) ?? []), city]);
    }
    return out;
  }, [cities, parents, byKey]);
  // 보이는 칸 사이의 길. 묶인 현의 길은 부모 칸으로 모아 그린다.
  const shown = (key: number) => {
    const city = byKey.get(key);
    if (!city) return null;
    if (isCounty(city) && !detached(city) && parents.has(key)) return parents.get(key)!;
    return key;
  };
  const edges = new Map<string, { a: SchematicCity; b: SchematicCity; mode: RouteMode }>();
  for (const city of cities)
    for (const other of city.links) {
      const a = shown(city.key);
      const b = shown(other);
      if (a === null || b === null || a === b) continue;
      const id = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (edges.has(id)) continue;
      const raw = city.key < other ? `${city.key}-${other}` : `${other}-${city.key}`;
      edges.set(id, { a: byKey.get(a)!, b: byKey.get(b)!, mode: routeModes?.get(raw) ?? 'LAND' });
    }

  // 처음에는 후보와 현재 도시가 모인 범위로 확대해 보인다. "전체 보기"로 천하 전체를 본다.
  const focusSet =
    candidates === null
      ? cities
      : cities.filter((city) => candidates.has(city.key) || city.key === here || city.key === value);
  const framed = showAll || focusSet.length === 0 ? cities : focusSet;
  const xs = framed.map((city) => city.x);
  const ys = framed.map((city) => city.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const pad = compact ? Math.max(12, Math.max(spanX, spanY) * 0.04) : Math.max(30, Math.max(spanX, spanY) * 0.18);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const width = Math.max(spanX + pad * 2, 160);
  const height = Math.max(spanY + pad * 2, 110);
  const unit = Math.max(width, height) / 70;

  const color = (city: SchematicCity) =>
    city.nationId === null ? '#8a857c' : (nationById.get(city.nationId)?.color ?? '#8a857c');
  const activate = (city: SchematicCity) => {
    const cluster = clusters.get(city.key) ?? [];
    if (cluster.some((county) => pickable(county.key))) {
      setOpened(city.key);
      return;
    }
    if (pickable(city.key)) onPick(city.key);
  };
  const onKey = (city: SchematicCity) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(city);
    }
  };

  const node = (city: SchematicCity, scale = 1) => {
    const cluster = clusters.get(city.key) ?? [];
    const clusterPicks = cluster.filter((county) => pickable(county.key)).length;
    const live = pickable(city.key) || clusterPicks > 0;
    const size = (isMajor(city) ? 2.2 + (city.level - 5) * 0.35 : isCounty(city) ? 1.4 : 1.7) * unit * scale;
    const capital = city.nationId !== null && nationById.get(city.nationId)?.capitalCityKey === city.key;
    // 축소 지도는 내 거점 이름만 보인다(칸이 작아 이름이 겹친다).
    const showName = compact ? city.key === here : live || city.key === value || city.key === here;
    return (
      <g
        key={city.key}
        className={styles.node}
        data-live={live ? 'true' : 'false'}
        data-selected={city.key === value ? 'true' : undefined}
        data-here={city.key === here ? 'true' : undefined}
        role="button"
        tabIndex={live ? 0 : -1}
        aria-label={`${city.name}${clusterPicks > 0 ? `, 딸린 현 ${clusterPicks}곳 고르기` : ''}`}
        aria-disabled={!live}
        onClick={() => activate(city)}
        onKeyDown={onKey(city)}
      >
        {city.kind === 'FIELD' ? (
          <polygon
            points={`${city.x - size * 0.4},${city.y + size * 0.6} ${city.x - size * 0.4},${city.y - size * 0.6} ${city.x + size * 0.5},${city.y - size * 0.3} ${city.x - size * 0.4},${city.y}`}
            fill={color(city)}
            className={styles.cell}
          />
        ) : city.kind === 'PASS' ? (
          <path
            d={`M${city.x - size * 0.7},${city.y + size * 0.45} v${-size * 0.9} h${size * 1.4} v${size * 0.9} h${-size * 0.45} v${-size * 0.45} h${-size * 0.5} v${size * 0.45} z`}
            fill={color(city)}
            className={styles.cell}
          />
        ) : (
          <rect
            x={city.x - size / 2}
            y={city.y - size / 2}
            width={size}
            height={size}
            fill={color(city)}
            className={styles.cell}
            transform={city.level === 1 ? `rotate(45 ${city.x} ${city.y})` : undefined}
          />
        )}
        {capital ? <circle cx={city.x} cy={city.y} r={size * 0.22} className={styles.capital} /> : null}
        {cluster.length > 0 ? (
          <text x={city.x + size * 0.7} y={city.y - size * 0.5} className={styles.badge} fontSize={unit * 1.6 * scale}>
            +{clusterPicks > 0 && candidates !== null ? clusterPicks : cluster.length}
          </text>
        ) : null}
        {showName ? (
          <text
            x={city.x}
            y={city.y + size * 0.6 + unit * 1.8 * scale}
            className={styles.name}
            fontSize={unit * 1.8 * scale}
          >
            {city.name}
          </text>
        ) : null}
      </g>
    );
  };

  // 지금 있는 군: 지금 도시가 현이면 그 부모, 큰 도시면 그 도시다.
  const homeParentKey = here === null ? null : (parents.get(here) ?? here);
  const homeParent = homeParentKey === null ? null : (byKey.get(homeParentKey) ?? null);
  const homeCounties = homeParent
    ? [homeParent, ...(clusters.get(homeParent.key) ?? [])].filter((city) => city.key !== here && isCounty(city))
    : [];
  const openedCity = opened === null ? null : (byKey.get(opened) ?? null);
  const openedCounties = opened === null ? [] : (clusters.get(opened) ?? []);
  return (
    <div className={styles.wrap} data-compact={compact || undefined}>
      <svg className={styles.map} viewBox={`${minX} ${minY} ${width} ${height}`} role="group" aria-label={label}>
        <g>
          {[...edges.values()].map(({ a, b, mode }) => (
            <line
              key={`${a.key}-${b.key}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={ROUTE_COLOR[mode]}
              strokeWidth={unit * 0.45}
              strokeDasharray={mode === 'SEA' ? `${unit} ${unit * 0.7}` : undefined}
              className={styles.edge}
            />
          ))}
        </g>
        {path && path.length > 1 ? (
          <polyline
            className={styles.path}
            strokeWidth={unit * 0.9}
            points={path
              .map((key) => byKey.get(key))
              .filter((city): city is SchematicCity => city !== undefined)
              .map((city) => `${city.x},${city.y}`)
              .join(' ')}
          />
        ) : null}
        <g>{visible.map((city) => node(city))}</g>
      </svg>
      {openedCity ? (
        <ClusterPanel
          parent={openedCity}
          counties={openedCounties}
          pickable={pickable}
          value={value}
          color={color}
          onPick={(key) => {
            onPick(key);
            setOpened(null);
          }}
          onClose={() => setOpened(null)}
        />
      ) : null}
      {/* 지금 있는 군의 부속 현은 지도 아래 줄에서 바로 고른다 (사용자 2026-11-15 "자기 군의 부속 현으로 가고싶을 수도"). */}
      {homeCounties.length > 0 ? (
        <div className={styles.homeRow} role="group" aria-label={`${homeParent?.name ?? '이'} 거점의 현`}>
          <span>{homeParent?.name ?? '이'} 거점의 현</span>
          {homeCounties.map((county) => (
            <button
              key={county.key}
              type="button"
              disabled={!pickable(county.key) || county.key === here}
              aria-pressed={county.key === value}
              onClick={() => onPick(county.key)}
            >
              {county.name}
            </button>
          ))}
        </div>
      ) : null}
      {compact ? null : (
        <>
          <button type="button" className={styles.zoom} onClick={() => setShowAll((all) => !all)}>
            {showAll ? '후보 둘레 보기' : '천하 전체 보기'}
          </button>
          <p className={styles.legend}>
            <span style={{ background: ROUTE_COLOR.LAND }} /> 육로 <span style={{ background: ROUTE_COLOR.RIVER }} />{' '}
            물길 <span style={{ background: ROUTE_COLOR.SEA }} /> 바닷길 <span className={styles.legendCounty} /> 딸린
            현(+N)
          </p>
        </>
      )}
    </div>
  );
}

function ClusterPanel({
  parent,
  counties,
  pickable,
  value,
  color,
  onPick,
  onClose,
}: {
  parent: SchematicCity;
  counties: readonly SchematicCity[];
  pickable: (key: number) => boolean;
  value: number | null;
  color: (city: SchematicCity) => string;
  onPick: (key: number) => void;
  onClose: () => void;
}) {
  const all = [parent, ...counties];
  return (
    <section className={styles.panel} aria-label={`${parent.name} 거점`}>
      <header className={styles.panelHead}>
        <b>{parent.name} 거점</b>
        <button type="button" onClick={onClose}>
          닫기
        </button>
      </header>
      <ul className={styles.panelList}>
        {all.map((city) => (
          <li key={city.key}>
            <button
              type="button"
              disabled={!pickable(city.key)}
              aria-pressed={city.key === value}
              onClick={() => onPick(city.key)}
            >
              <span className={styles.swatch} style={{ background: color(city) }} />
              {city.name}
              <small>{city.key === parent.key ? '거점' : '현'}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
