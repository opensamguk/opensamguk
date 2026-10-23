import { readableTextColor } from '../ui/color';
import type { MapCity, MapNation } from '../game/types';
import styles from './WorldMap.module.css';

// 지도 좌표계. che 지도의 도시 좌표(25~680, 20~480)를 그대로 쓴다.
export const MAP_WIDTH = 700;
export const MAP_HEIGHT = 500;
const NEUTRAL = '#d6d0c4';

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
export const isCut = (city: Pick<MapCity, 'supplied' | 'nationId'>) => !city.supplied && city.nationId !== null;

// 도시 규모(1~8)에 따라 점 크기를 키운다.
export const cityRadius = (level: number) => 4 + Math.max(1, Math.min(8, level)) * 0.6;

export function cityLabel(city: MapCity, nation: MapNation | undefined, mine: boolean): string {
  return [city.name, nation ? nation.name : '공백지', isCut(city) ? '보급 끊김' : null, mine ? '내 위치' : null]
    .filter(Boolean)
    .join(', ');
}

// 94도시 지도. 도시를 누르면 onSelect로 알려 준다. 화면 이동은 부모가 정한다 (메인은 같은 화면 안에서 도시 정보만 바꾼다).
export function WorldMap({
  cities,
  nations,
  myCityKey,
  selectedKey,
  onSelect,
}: {
  cities: readonly MapCity[];
  nations: readonly MapNation[];
  myCityKey: number | null;
  selectedKey: number | null;
  onSelect: (key: number) => void;
}) {
  const nationById = new Map(nations.map((nation) => [nation.id, nation]));
  return (
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
        const labelWidth = Array.from(city.name).length * 10 + 6;
        const select = () => onSelect(city.key);
        return (
          <g
            key={city.key}
            className={styles.city}
            role="button"
            tabIndex={0}
            aria-label={cityLabel(city, nation, mine)}
            aria-pressed={selected}
            data-city-key={city.key}
            data-nation-id={city.nationId ?? ''}
            data-supplied={city.supplied}
            data-cut={isCut(city) || undefined}
            data-mine={mine || undefined}
            onClick={select}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                select();
              }
            }}
          >
            <title>{cityLabel(city, nation, mine)}</title>
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
              {city.name}
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
}

// 지도 아래 범례. 색만으로 뜻을 전하지 않도록 기호와 글자를 같이 쓴다.
export function MapLegend({ cities, nations }: { cities: readonly MapCity[]; nations: readonly MapNation[] }) {
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
      <span className={styles.legendItem}>
        <svg width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="5" className={styles.mine} />
        </svg>
        내 위치
      </span>
      <span className={styles.legendItem}>
        <svg width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="5" className={`${styles.dot} ${styles.unsupplied}`} style={{ fill: NEUTRAL }} />
        </svg>
        보급 끊김 {unsupplied}
      </span>
      <span className={styles.legendItem}>
        <svg width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="5" className={styles.dot} style={{ fill: NEUTRAL }} />
        </svg>
        공백지 {empty}
      </span>
      {ranked.map(({ nation, count }) => (
        <span key={nation.id} className={styles.legendItem} data-nation-id={nation.id}>
          <span className={styles.swatch} style={{ background: nation.color }} aria-hidden="true" />
          {nation.name} {count}
        </span>
      ))}
    </div>
  );
}
