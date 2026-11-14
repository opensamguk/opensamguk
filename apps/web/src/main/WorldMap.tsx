import type { PublicGeography } from '@opensamguk/shared';
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { OperationalWorldMap } from './OperationalWorldMap';
import { CAPITAL_MARK, isCapital, levelName, type DrawnNation } from './siteMarkers';
import { readableTextColor } from '../ui/color';
import type { MapCity } from '../game/types';
import { MapGenerals } from './MapGenerals';
import { generalsByCity, generalsText, type MapGeneral } from './mapGeneralList';
import tooltipStyles from './OperationalWorldMap.module.css';
import styles from './WorldMap.module.css';

// 3D 군략도 시제품 (INT-27 0단계, D-089). 지연 로드라 첫 화면 번들에 들어가지 않는다.
const Map3D = lazy(() => import('../map3d/Map3D'));

// 주소에 ?map=3d가 있고 WebGL2가 될 때만 3D로 그린다. 아니면 지금 SVG 지도다.
export function wants3dMap(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (new URLSearchParams(window.location.search).get('map') !== '3d') return false;
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

// 지도 좌표계. che 지도의 도시 좌표(25~680, 20~480)를 그대로 쓴다.
export const MAP_WIDTH = 700;
export const MAP_HEIGHT = 500;
const NEUTRAL = '#d6d0c4';

// 예전 공개 지도 사본에는 보급 값이 없을 수 있다.
type DrawnCity = Omit<MapCity, 'supplied'> & { supplied?: boolean };

// 연결선은 양쪽에 같은 연결이 있으므로 한 번만 그린다. 없는 도시를 가리키는 연결은 버린다.
// 지도 편집기(mapEditor)도 같은 함수로 연결선을 그려서 key·links만 요구한다.
export function mapLinks<T extends Pick<MapCity, 'key' | 'links'>>(cities: readonly T[]): Array<[T, T]> {
  const byKey = new Map(cities.map((city) => [city.key, city]));
  const seen = new Set<string>();
  const links: Array<[T, T]> = [];
  for (const city of cities) {
    for (const key of city.links) {
      const other = byKey.get(key);
      if (!other || other.key === city.key) continue;
      const id = city.key < other.key ? `${city.key}-${other.key}` : `${other.key}-${city.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      links.push([city, other]);
    }
  }
  return links;
}

// 보급은 국가 도시에만 뜻이 있다. 공백지는 늘 보급이 없으므로 끊김 표시를 하지 않는다.
export const isCut = (city: Pick<DrawnCity, 'supplied' | 'nationId'>) =>
  city.supplied === false && city.nationId !== null;

// 도시 규모(1~8)에 따라 점 크기를 키운다.
export const cityRadius = (level: number) => 4 + Math.max(1, Math.min(8, level)) * 0.6;

export function cityLabel(city: DrawnCity, nation: DrawnNation | undefined, mine: boolean): string {
  return [
    city.name,
    // 지역 이름 (world.map regionName, INT-26). 공개 지도처럼 받지 않으면 뺀다.
    city.regionName ?? null,
    nation ? nation.name : '공백지',
    isCapital(city, nation) ? '수도' : null,
    isCut(city) ? '보급 끊김' : null,
    mine ? '내 위치' : null,
    city.ruin ? `폐허 복구 ${city.ruin.percent}%` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

// 94도시 지도. 도시를 누르면 onSelect로 알려 준다. 화면 이동은 부모가 정한다 (메인은 같은 화면 안에서 도시 정보만 바꾼다).
// onSelect가 없으면 읽기 전용이다 (공개 지도, T2-25). 도시를 눌러도 아무 일이 없고 초점도 받지 않는다.
export function WorldMap({
  cities,
  nations,
  myCityKey = null,
  myNationId,
  selectedKey = null,
  onSelect,
  operationalMap,
  fill = false,
  focusKey = null,
  generals,
}: {
  cities: readonly DrawnCity[];
  nations: readonly DrawnNation[];
  // 거점별 장수 (world.map generals, INT-26). 풍선에 얼굴·이름을 쓴다. 공개 지도·영토 재생은 주지 않는다.
  generals?: readonly MapGeneral[] | undefined;
  myCityKey?: number | null;
  // 운영 지도의 거점 고르기를 본국·타국·공백지로 묶을 때 쓰는 내 국가 (INT-25). 안 주면 묶지 않는다.
  myNationId?: number | null | undefined;
  selectedKey?: number | null;
  onSelect?: (key: number) => void;
  operationalMap?: PublicGeography | undefined;
  fill?: boolean;
  // 운영 지도에서 처음 열 때 가운데 둘 거점 (인자 입력 화면, INT-25).
  focusKey?: number | null;
}) {
  // 장수를 받은 고전 지도는 마우스를 올린 도시의 풍선을 띄운다 (운영 지도 풍선과 같은 모양, INT-26).
  const [hover, setHover] = useState<{ key: number; x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const use3d = useMemo(() => wants3dMap(), []);
  if (operationalMap && use3d)
    return (
      <Suspense fallback={<p role="status">3D 지도를 불러오는 중입니다</p>}>
        <Map3D
          cities={cities}
          nations={nations}
          map={operationalMap}
          myCityKey={myCityKey}
          selectedKey={selectedKey}
          onSelect={onSelect}
          fill={fill}
        />
      </Suspense>
    );
  if (operationalMap)
    return (
      <OperationalWorldMap
        cities={cities}
        nations={nations}
        myCityKey={myCityKey}
        myNationId={myNationId}
        selectedKey={selectedKey}
        {...(onSelect ? { onSelect } : {})}
        map={operationalMap}
        fill={fill}
        focusKey={focusKey}
        generals={generals}
      />
    );
  if (cities.some((city) => city.kind !== undefined)) return <p role="alert">운영 지도 자료를 다시 불러오세요.</p>;
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  const generalsAt = generalsByCity(generals);
  const balloon = generals !== undefined;
  const svg = (
    <svg
      className={styles.map}
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      role="group"
      aria-label={`중원 지도, 도시 ${cities.length}개`}
      data-testid="world-map"
    >
      <rect className={styles.ground} width={MAP_WIDTH} height={MAP_HEIGHT} />
      <g aria-hidden="true">
        {mapLinks(cities).map(([a, b]) => (
          <line key={`${a.key}-${b.key}`} className={styles.link} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        ))}
      </g>
      {cities.map((city) => {
        const nation = city.nationId === null ? undefined : nationById.get(city.nationId);
        const fill = nation?.color ?? NEUTRAL;
        const mine = city.key === myCityKey;
        const selected = city.key === selectedKey;
        const r = cityRadius(city.level);
        const name = `${isCapital(city, nation) ? CAPITAL_MARK : ''}${city.name}${city.ruin ? ' (폐허)' : ''}`;
        const labelWidth = Array.from(name).length * 10 + 6;
        const select = onSelect ? () => onSelect(city.key) : undefined;
        const here = generalsText(generalsAt.get(city.key) ?? []);
        return (
          <g
            key={city.key}
            className={select ? styles.city : styles.readOnlyCity}
            role={select ? 'button' : 'img'}
            tabIndex={select ? 0 : undefined}
            aria-label={cityLabel(city, nation, mine)}
            aria-pressed={select ? selected : undefined}
            data-city-key={city.key}
            data-nation-id={city.nationId ?? ''}
            data-ruin={city.ruin?.percent}
            data-supplied={city.supplied}
            data-cut={isCut(city) || undefined}
            data-mine={mine || undefined}
            onPointerMove={
              balloon
                ? (event) => {
                    if (event.pointerType !== 'mouse') return;
                    const box = frame.current?.getBoundingClientRect();
                    if (box) setHover({ key: city.key, x: event.clientX - box.left, y: event.clientY - box.top });
                  }
                : undefined
            }
            onPointerLeave={balloon ? () => setHover((old) => (old?.key === city.key ? null : old)) : undefined}
            onClick={select}
            onKeyDown={
              select &&
              ((event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select();
                }
              })
            }
          >
            <title>
              {cityLabel(city, nation, mine)}
              {levelName(city.level) ? ` · ${levelName(city.level)}` : ''}
              {here ? ` · ${here}` : ''}
            </title>
            {mine ? <circle className={styles.mine} cx={city.x} cy={city.y} r={r + 5} /> : null}
            {selected ? <circle className={styles.selected} cx={city.x} cy={city.y} r={r + 3} /> : null}
            <circle
              className={isCut(city) ? `${styles.dot} ${styles.unsupplied}` : styles.dot}
              cx={city.x}
              cy={city.y}
              r={r}
              style={{ fill }}
            />
            {!isCut(city) ? null : (
              <path
                className={styles.cut}
                d={`M${city.x - r * 0.6} ${city.y - r * 0.6} L${city.x + r * 0.6} ${city.y + r * 0.6}`}
              />
            )}
            <rect
              className={styles.labelBox}
              x={city.x - labelWidth / 2}
              y={city.y + r + 1}
              width={labelWidth}
              height={13}
              rx={2}
              style={{ fill: nation?.color ?? 'var(--color-surface)' }}
            />
            <text
              className={styles.label}
              x={city.x}
              y={city.y + r + 11}
              style={{ fill: nation ? readableTextColor(nation.color) : 'var(--color-text)' }}
            >
              {name}
            </text>
            {mine ? (
              <text className={styles.mineText} x={city.x} y={city.y - r - 7}>
                내 위치
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
  if (!balloon) return svg;
  const hovered = hover ? cities.find((city) => city.key === hover.key) : undefined;
  return (
    <div ref={frame} className={styles.frame}>
      {svg}
      {hover && hovered ? (
        <ClassicBalloon
          city={hovered}
          nation={hovered.nationId === null ? undefined : nationById.get(hovered.nationId)}
          mine={hovered.key === myCityKey}
          generals={generalsAt.get(hovered.key) ?? []}
          x={hover.x}
          y={hover.y}
          width={frame.current?.clientWidth ?? 0}
          height={frame.current?.clientHeight ?? 0}
        />
      ) : null}
    </div>
  );
}

// 고전 지도의 풍선. 내용은 도시 읽기 이름(cityLabel)·SVG title과 같고 장수 얼굴만 더한다. 화면 낭독기는 title을 읽는다.
function ClassicBalloon({
  city,
  nation,
  mine,
  generals,
  x,
  y,
  width,
  height,
}: {
  city: DrawnCity;
  nation: DrawnNation | undefined;
  mine: boolean;
  generals: readonly MapGeneral[];
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const grade = levelName(city.level);
  const notes = [
    isCapital(city, nation) ? '수도' : null,
    mine ? '내 위치' : null,
    city.ruin ? `폐허 복구 ${city.ruin.percent}%` : null,
    isCut(city) ? '보급 끊김' : null,
  ].filter((note): note is string => note !== null);
  // 커서 오른쪽 아래에 띄우되 지도 밖으로 나가면 왼쪽·위로 넘긴다.
  const right = x > width - 200;
  const below = y < 120;
  return (
    <div
      className={tooltipStyles.tooltip}
      data-testid="map-tooltip"
      aria-hidden="true"
      style={{
        left: right ? undefined : x + 14,
        right: right ? Math.max(0, width - x + 14) : undefined,
        top: below ? y + 18 : undefined,
        bottom: below ? undefined : Math.max(0, height - y + 10),
      }}
    >
      <p className={tooltipStyles.tooltipTitle}>
        <span>{city.name}</span>
        <span className={tooltipStyles.tooltipGrade}>
          {city.regionName ? `${city.regionName} · ` : ''}
          {grade ?? `규모 ${city.level}`}
        </span>
      </p>
      <p className={tooltipStyles.tooltipOwner}>
        <span className={tooltipStyles.tooltipSwatch} style={{ background: nation?.color ?? NEUTRAL }} />
        {nation?.name ?? '공백지'}
      </p>
      {notes.map((note) => (
        <p key={note} className={tooltipStyles.tooltipNote}>
          {note}
        </p>
      ))}
      <MapGenerals generals={generals} />
    </div>
  );
}

// 지도 아래 범례. 색만으로 뜻을 전하지 않도록 기호와 글자를 같이 쓴다.
// 공개 지도에서는 내 위치를 숨기고 사본에 보급 정보가 있을 때 범례에 표시한다.
export function MapLegend({
  cities,
  nations,
  readOnly = false,
}: {
  cities: readonly DrawnCity[];
  nations: readonly DrawnNation[];
  readOnly?: boolean;
}) {
  const counts = new Map<number, number>();
  for (const city of cities)
    if (city.nationId !== null) counts.set(city.nationId, (counts.get(city.nationId) ?? 0) + 1);
  const ranked = nations
    .map((nation) => ({ nation, count: counts.get(nation.id) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.nation.id - b.nation.id);
  const unsupplied = cities.filter(isCut).length;
  const empty = cities.filter((city) => city.nationId === null).length;
  return (
    <div className={styles.legend} aria-label="지도 범례">
      {readOnly ? null : (
        <span className={styles.legendItem}>
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className={styles.mine} />
          </svg>
          내 위치
        </span>
      )}
      {!readOnly || cities.some((city) => city.supplied !== undefined) ? (
        <span className={styles.legendItem}>
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className={`${styles.dot} ${styles.unsupplied}`} style={{ fill: NEUTRAL }} />
          </svg>
          보급 끊김 {unsupplied}
        </span>
      ) : null}
      {readOnly || empty === 0 ? (
        <span className={styles.legendItem}>
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className={styles.dot} style={{ fill: NEUTRAL }} />
          </svg>
          공백지 {empty}
        </span>
      ) : (
        // 원작 세력일람의 【재야】 속령 일람. 누르면 공백지 이름을 펼친다 (INT-25).
        <details className={styles.emptyList}>
          <summary className={styles.legendItem}>
            <svg width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="5" className={styles.dot} style={{ fill: NEUTRAL }} />
            </svg>
            공백지 {empty}
          </summary>
          <span className={styles.emptyNames}>
            {cities
              .filter((city) => city.nationId === null)
              .map((city) => city.name)
              .join(', ')}
          </span>
        </details>
      )}
      {ranked.map(({ nation, count }) => (
        <span key={nation.id} className={styles.legendItem} data-nation-id={nation.id}>
          <span className={styles.swatch} style={{ background: nation.color }} aria-hidden="true" />
          {nation.name} {count}
        </span>
      ))}
    </div>
  );
}
