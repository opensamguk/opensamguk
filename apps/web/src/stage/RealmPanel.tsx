// 천하 형세 판 (INT-29 전체 지도 모드의 판 정보). 세력마다 수도·도시 수·큰 도시 수·장수 수를 견준다.
// 값은 지도 조회(world.map)에 있는 것만 쓴다. 안개 규칙이 켜진 월드는 장수가 보이는 범위만 온다(표 설명에 적는다).
import { Link } from '@tanstack/react-router';
import type { MapCity, MapNation } from '../game/types';
import type { MapGeneral } from '../main/mapGeneralList';
import { NationBadge } from '../ui/NationBadge';
import styles from './RealmPanel.module.css';

/** 큰 도시: 대(7) 이상. */
const BIG_CITY = 7;

export type RealmRow = {
  nation: MapNation;
  cities: number;
  bigCities: number;
  generals: number;
  capitalName: string | null;
};

export function realmRows(
  nations: readonly MapNation[],
  cities: readonly Pick<MapCity, 'key' | 'name' | 'nationId' | 'level'>[],
  generals: readonly Pick<MapGeneral, 'nationId'>[],
): RealmRow[] {
  const nameOf = new Map(cities.map((city) => [city.key, city.name]));
  return nations
    .map((nation) => {
      const own = cities.filter((city) => city.nationId === nation.id);
      return {
        nation,
        cities: own.length,
        bigCities: own.filter((city) => (city.level ?? 0) >= BIG_CITY).length,
        generals: generals.filter((general) => general.nationId === nation.id).length,
        capitalName: nation.capitalCityKey == null ? null : (nameOf.get(nation.capitalCityKey) ?? null),
      };
    })
    .filter((row) => row.cities > 0)
    .sort((a, b) => b.cities - a.cities || b.bigCities - a.bigCities || a.nation.id - b.nation.id);
}

export function RealmPanel({
  worldId,
  nations,
  cities,
  generals,
  myNationId,
}: {
  worldId: string;
  nations: readonly MapNation[];
  cities: readonly Pick<MapCity, 'key' | 'name' | 'nationId' | 'level'>[];
  generals: readonly Pick<MapGeneral, 'nationId'>[];
  myNationId: number | null;
}) {
  const rows = realmRows(nations, cities, generals);
  const empty = cities.filter((city) => city.nationId === null).length;
  return (
    <div className={styles.realm}>
      <p className={styles.summary}>
        세력 <b>{rows.length}</b> · 도시 <b>{cities.length}</b> · 공백지 <b>{empty}</b>
      </p>
      <table className={styles.table}>
        <caption className={styles.caption}>
          세력마다 도시가 많은 차례. 안개 규칙이 켜진 월드는 보이는 장수만 셉니다.
        </caption>
        <thead>
          <tr>
            <th scope="col">세력</th>
            <th scope="col">수도</th>
            <th scope="col">도시</th>
            <th scope="col">큰 도시</th>
            <th scope="col">장수</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.nation.id} className={row.nation.id === myNationId ? styles.mine : undefined}>
              <th scope="row">
                <Link
                  to="/w/$worldId/nation/$nationId"
                  params={{ worldId, nationId: String(row.nation.id) }}
                  className={styles.nation}
                >
                  <NationBadge name={row.nation.name} color={row.nation.color} />
                </Link>
              </th>
              <td>{row.capitalName ?? '—'}</td>
              <td className="num">{row.cities}</td>
              <td className="num">{row.bigCities}</td>
              <td className="num">{row.generals}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
