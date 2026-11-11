import type { ReactNode } from 'react';
import type { MapCity } from '../game/types';
import { DataTable, type Column } from '../ui/DataTable';
import { NationBadge } from '../ui/NationBadge';
import { EmptyState } from '../ui/States';
import { Tag } from '../ui/Tag';
import styles from './Intel.module.css';
import type { IntelRecordsResponse, IntelRecordView } from './types';
import {
  OWNER_CHANGED,
  RECORD_NOTE,
  ageLabel,
  crewText,
  crewTypesText,
  levelLabel,
  missingReason,
  ownerChanged,
  recordedAtText,
  techLabel,
  trustText,
  type MissingColumn,
} from './view';

type CityRef = Pick<MapCity, 'key' | 'name' | 'nationId'>;

const number = (value: number) => value.toLocaleString('ko-KR');

// 기록에 없는 칸. 화면에는 —, 마우스를 올리거나 화면 읽기로 이유를 듣는다.
function Missing({ reason }: { reason: string }) {
  return (
    <span>
      <span aria-hidden="true">—</span>
      <span className={styles.srOnly}>기록 없음, {reason}</span>
    </span>
  );
}

function optional<K extends MissingColumn>(
  key: K,
  label: string,
  render: (value: NonNullable<IntelRecordView[K]>) => ReactNode,
  sortValue?: (value: NonNullable<IntelRecordView[K]>) => number | string,
  numeric = false,
): Column<IntelRecordView> {
  // 선택 칸은 기록에 없으면 키 자체가 없다(T4-12 §2.2).
  const pick = (row: IntelRecordView) => row[key] as NonNullable<IntelRecordView[K]> | undefined;
  return {
    key,
    label,
    numeric,
    render: (row) => {
      const value = pick(row);
      return value === undefined ? <Missing reason={missingReason(row, key)} /> : render(value);
    },
    title: (row) => (pick(row) === undefined ? missingReason(row, key) : undefined),
    ...(sortValue
      ? {
          sortValue: (row: IntelRecordView) => {
            const value = pick(row);
            return value === undefined ? null : sortValue(value);
          },
        }
      : {}),
  };
}

type Domestic = NonNullable<IntelRecordView['domestic']>;
const domesticColumn = (key: string, label: string, pick: (d: Domestic) => [number, number]) => ({
  ...optional(
    'domestic',
    label,
    (d) => {
      const [value, max] = pick(d);
      return `${number(value)} / ${number(max)}`;
    },
    (d) => pick(d)[0],
    true,
  ),
  key,
});

// 첩보 기록 표(T4-13 §1.4). 서버가 보낸 기록을 도시마다 한 줄로 그린다. 값을 지어내거나 지금 값으로 채우지 않는다.
export function IntelRecordList({
  records,
  cities,
  onSelectCity,
}: {
  records: readonly IntelRecordView[];
  cities: readonly CityRef[];
  onSelectCity?: (cityKey: number) => void;
}) {
  const cityByKey = new Map(cities.map((city) => [city.key, city]));
  const cityName = (key: number) => cityByKey.get(key)?.name ?? String(key);
  const columns: Column<IntelRecordView>[] = [
    {
      key: 'city',
      label: '도시',
      sortValue: (row) => cityName(row.cityKey),
      render: (row) =>
        onSelectCity ? (
          <button
            type="button"
            className={styles.cityButton}
            onClick={() => onSelectCity(row.cityKey)}
            aria-label={`${cityName(row.cityKey)}, 지도에서 보기`}
          >
            {cityName(row.cityKey)}
          </button>
        ) : (
          cityName(row.cityKey)
        ),
    },
    {
      key: 'recorded',
      label: '기록',
      sortValue: (row) => row.tick,
      render: (row) => recordedAtText(row),
    },
    { key: 'level', label: '정보', sortValue: (row) => row.level, render: (row) => levelLabel(row.level) },
    {
      key: 'owner',
      label: '당시 주인',
      sortValue: (row) => row.owner?.name ?? '',
      render: (row) => (
        <span className={styles.owner}>
          {row.owner ? (
            <NationBadge name={row.owner.name} color={row.owner.color} />
          ) : (
            <NationBadge name="공백지" color={null} />
          )}
          {ownerChanged(row, cityByKey.get(row.cityKey)?.nationId) ? <Tag tone="info">{OWNER_CHANGED}</Tag> : null}
        </span>
      ),
    },
    {
      key: 'population',
      label: '주민',
      numeric: true,
      sortValue: (row) => row.population,
      render: (row) => `${number(row.population)} / ${number(row.populationMax)}`,
    },
    {
      key: 'trust',
      label: '민심',
      numeric: true,
      sortValue: (row) => row.trust,
      render: (row) => trustText(row.trust),
    },
    {
      key: 'generals',
      label: '장수',
      numeric: true,
      sortValue: (row) => row.generals,
      render: (row) => number(row.generals),
    },
    {
      key: 'crew',
      label: '병력',
      numeric: true,
      sortValue: (row) => row.crew.min,
      render: (row) => crewText(row.crew),
    },
    domesticColumn('agriculture', '농업', (d) => [d.agriculture, d.agricultureMax]),
    domesticColumn('commerce', '상업', (d) => [d.commerce, d.commerceMax]),
    domesticColumn('security', '치안', (d) => [d.security, d.securityMax]),
    domesticColumn('defence', '수비', (d) => [d.defence, d.defenceMax]),
    domesticColumn('wall', '성벽', (d) => [d.wall, d.wallMax]),
    optional('crewTypes', '병종', crewTypesText),
    optional('tech', '기술', techLabel),
  ];
  return (
    <div className={styles.list}>
      <DataTable
        caption={`첩보 기록 ${records.length}곳`}
        rows={records}
        columns={columns}
        rowKey={(row) => row.cityKey}
        rowLabel={(row) =>
          `${cityName(row.cityKey)} 첩보 기록, ${ageLabel(row.ageMonths)}, 정보 ${levelLabel(row.level)}`
        }
        mobileDetails={[
          'recorded',
          'level',
          'owner',
          'population',
          'trust',
          'generals',
          'crew',
          'agriculture',
          'commerce',
          'security',
          'defence',
          'wall',
          'crewTypes',
          'tech',
        ]}
      />
      <p className={styles.note}>{RECORD_NOTE} 기술은 내 나라와 비교한 값입니다.</p>
    </div>
  );
}

// 응답을 받은 뒤의 네 상태(T4-13 §1.3). 불러오는 중·장수 없음·불러오기 실패는 연결하는 쪽이 기존 부품으로 그린다.
export function IntelRecordsPanel({
  data,
  ronin,
  cities,
  onSelectCity,
  onReload,
  reloading = false,
}: {
  data: IntelRecordsResponse;
  ronin: boolean;
  cities: readonly CityRef[];
  onSelectCity?: (cityKey: number) => void;
  onReload?: () => void;
  reloading?: boolean;
}) {
  const body = !data.enabled ? (
    <EmptyState title="이 월드에서는 첩보를 쓰지 않습니다" />
  ) : data.items.length === 0 && ronin ? (
    <EmptyState title="국가에 소속되면 나라의 첩보 기록을 봅니다" />
  ) : data.items.length === 0 ? (
    <EmptyState title="아직 첩보 기록이 없습니다">
      <p>예턴에 첩보를 넣으면 그 도시의 그때 값이 기록됩니다.</p>
    </EmptyState>
  ) : (
    <IntelRecordList records={data.items} cities={cities} {...(onSelectCity ? { onSelectCity } : {})} />
  );
  // 이름 붙은 영역은 감싸는 쪽(기록 화면의 Panel)이 준다. 여기서 같은 이름의 영역을 하나 더 만들지 않는다.
  return (
    <div className={styles.panel} data-intel-enabled={data.enabled ? 'true' : 'false'}>
      {onReload ? (
        <div className={styles.toolbar}>
          <button type="button" className={styles.reload} onClick={onReload} disabled={reloading}>
            다시 불러오기
          </button>
        </div>
      ) : null}
      {body}
    </div>
  );
}
