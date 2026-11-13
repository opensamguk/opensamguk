import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorldMap as WorldMapData } from '../game/types';
import type { WorldUnitSet } from '../battleSim/unitChoices';
import { levelName, isCapital } from '../main/siteMarkers';
import { WorldMap } from '../main/WorldMap';
import { NationBadge } from '../ui/NationBadge';
import { cityDistances, displayName, groupByDistance } from './targets';
import styles from './CommandArgsScreen.module.css';

// 인자가 있는 명령의 입력 화면 (INT-25, D-083). 원작처럼 화면 전체를 덮는다.
// 주소는 바꾸지 않는다. Esc·명령 취소로 닫고 명령 다시 고르기로 카드 목록에 돌아간다.
// 값이 맞는지는 서버의 사전 검사와 실행이 판정한다. 화면은 고르기를 돕는 자료만 보인다.
// 자료는 편집기가 이미 받은 조회(지도·내 장수·병종표)를 넘겨받는다. 없으면 지도 없이 목록만 보인다.
export interface ArgContext {
  map?: WorldMapData | undefined;
  here: number | null;
  ownNationId: number | null;
  wallet?: { gold: number; rice: number } | undefined;
  unitSet?: WorldUnitSet | undefined;
  recruitment?: { byCrewType: Record<string, { message: string } | null> } | undefined;
}
export function CommandArgsScreen({
  title,
  slotLabel,
  onCancel,
  onReselect,
  notes,
  summary,
  putButton,
  children,
  context,
}: {
  context: ArgContext;
  title: string;
  slotLabel: string;
  onCancel: () => void;
  onReselect: () => void;
  notes: ReactNode;
  summary: string;
  putButton: ReactNode;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const element = dialog.current;
    // 시험 환경(jsdom)에는 showModal이 없다. 그때는 open 속성만으로 그린다.
    if (element && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    return () => {
      if (element?.open && typeof element.close === 'function') element.close();
    };
  }, []);

  const general = context.wallet;
  return (
    <dialog
      ref={dialog}
      className={styles.screen}
      aria-labelledby={headingId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      data-testid="command-args-screen"
    >
      <header className={styles.bar}>
        <button type="button" className={styles.barButton} onClick={onCancel}>
          명령 취소
        </button>
        <button type="button" className={styles.barButton} onClick={onReselect}>
          명령 다시 고르기
        </button>
        <h2 id={headingId} className={styles.title}>
          {title}
          <span className={styles.slot}>{slotLabel}</span>
        </h2>
      </header>
      <div className={styles.notes} role="group" aria-label="명령 안내">
        {general ? (
          <span className={styles.wallet}>
            내 금 <span className="num">{general.gold.toLocaleString('ko-KR')}</span> · 쌀{' '}
            <span className="num">{general.rice.toLocaleString('ko-KR')}</span>
          </span>
        ) : null}
        {notes}
      </div>
      <div className={styles.body}>{children}</div>
      <footer className={styles.foot}>
        <p className={styles.summary} aria-live="polite">
          {summary}
        </p>
        {putButton}
      </footer>
    </dialog>
  );
}

interface CityOption {
  key: number;
  name: string;
}

// 도시 대상 고르기. 왼쪽 지도에서 누르거나 오른쪽 거리별 목록에서 고른다.
// 후보는 명령이 정한 도시(교역 대상 등)이고, 없으면 지도의 모든 도시다. 내 도시를 기본값으로 두지 않는다.
export function CityTargetPicker({
  label,
  value,
  options,
  note,
  onChange,
  context,
}: {
  context: ArgContext;
  label: string;
  value: string;
  options: readonly CityOption[];
  note: string | null;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const listId = useId();
  const map = context.map;
  const cities = useMemo(
    () => map?.cities ?? options.map((option) => ({ ...option, level: 0, nationId: null, links: [] as number[] })),
    [map, options],
  );
  const nations = useMemo(() => map?.nations ?? [], [map]);
  const nationById = useMemo(() => new Map(nations.map((nation) => [nation.id, nation])), [nations]);
  const here = context.here;
  const ownNation = context.ownNationId;
  const distances = useMemo(() => cityDistances(cities, here), [cities, here]);
  const allowed = useMemo(() => new Set(options.map((option) => option.key)), [options]);
  const candidates = useMemo(
    () =>
      cities
        .filter((city) => allowed.has(city.key) && city.key !== here)
        .filter((city) => query.trim() === '' || city.name.includes(query.trim())),
    [cities, allowed, here, query],
  );
  const groups = useMemo(() => groupByDistance(candidates, distances, ownNation), [candidates, distances, ownNation]);
  const selected = cities.find((city) => String(city.key) === value) ?? null;
  const herCity = cities.find((city) => city.key === here) ?? null;
  const pick = (key: number) => {
    if (allowed.has(key)) onChange(String(key));
  };
  const describe = (city: { key: number; level: number; nationId: number | null }) => {
    const nation = city.nationId === null ? undefined : nationById.get(city.nationId);
    const distance = distances.get(city.key);
    return [
      nation ? nation.name : '공백지',
      levelName(city.level) ? `${levelName(city.level)} 도시` : null,
      isCapital(city, nation) ? '수도' : null,
      distance === undefined ? '연결 없음' : `${here === null ? '' : '현재 도시에서 '}${distance}칸`,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  return (
    <div className={styles.target}>
      <section className={styles.mapPane} aria-label={`${label} 지도`}>
        <div className={styles.map}>
          {map ? (
            <WorldMap
              fill
              operationalMap={map.operationalMap}
              cities={map.cities}
              nations={nations}
              myCityKey={here}
              selectedKey={selected?.key ?? null}
              focusKey={here}
              onSelect={pick}
            />
          ) : (
            <p className={styles.muted}>지도를 불러오는 중입니다</p>
          )}
        </div>
        <p className={styles.muted}>지도에서 도시를 누르거나 목록에서 고릅니다.</p>
        <p className={styles.route}>
          <span className={styles.tagHere}>현재 도시</span> {herCity?.name ?? '—'} →{' '}
          <span className={styles.tagPick}>선택 도시</span> {selected ? selected.name : '고르지 않음'}
          {selected ? <span className={styles.muted}> · {describe(selected)}</span> : null}
        </p>
        {note ? (
          <p className={styles.muted} role="note">
            {note}
          </p>
        ) : null}
      </section>
      <section className={styles.listPane} aria-label={`${label} 목록`}>
        <label className={styles.find}>
          <span>{label} 찾기</span>
          <input type="search" value={query} aria-controls={listId} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div id={listId} className={styles.list} role="radiogroup" aria-label={label}>
          {groups.length === 0 ? <p className={styles.muted}>고를 수 있는 도시가 없습니다</p> : null}
          {groups.map((group) => (
            <div key={group.distance ?? 'none'} className={styles.group}>
              <p className={styles.groupHead}>
                {group.distance === null ? '연결 없음' : `${group.distance}칸`} · {group.items.length}곳
              </p>
              {group.items.map((city) => {
                const nation = city.nationId === null ? undefined : nationById.get(city.nationId);
                const own = ownNation !== null && city.nationId === ownNation;
                const level = levelName(city.level);
                return (
                  <button
                    key={city.key}
                    type="button"
                    role="radio"
                    aria-checked={String(city.key) === value}
                    className={styles.row}
                    onClick={() => pick(city.key)}
                  >
                    <span className={styles.rowName}>{city.name}</span>
                    <NationBadge name={nation ? nation.name : '공백지'} color={nation?.color ?? null} />
                    <span className={styles.muted}>
                      {[level, isCapital(city, nation) ? '수도' : null, own ? '아국' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// 국가 대상 고르기. 지도에서 도시를 누르면 그 도시의 국가를 고른다.
export function NationTargetPicker({
  label,
  value,
  options,
  onChange,
  context,
}: {
  context: ArgContext;
  label: string;
  value: string;
  options: ReadonlyArray<{ id: number; name: string }>;
  onChange: (value: string) => void;
}) {
  const map = context.map;
  const cities = useMemo(() => map?.cities ?? [], [map]);
  const nations = useMemo(
    () =>
      map?.nations ??
      options.map((option) => ({ ...option, color: null as string | null, capitalCityKey: null as number | null })),
    [map, options],
  );
  const allowed = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const cityCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const city of cities)
      if (city.nationId !== null) counts.set(city.nationId, (counts.get(city.nationId) ?? 0) + 1);
    return counts;
  }, [cities]);
  const rows = nations
    .filter((nation) => allowed.has(nation.id))
    .sort((a, b) => (cityCount.get(b.id) ?? 0) - (cityCount.get(a.id) ?? 0) || a.name.localeCompare(b.name, 'ko'));
  const selectedNation = nations.find((nation) => String(nation.id) === value);
  const capital = selectedNation?.capitalCityKey ?? null;
  return (
    <div className={styles.target}>
      <section className={styles.mapPane} aria-label={`${label} 지도`}>
        <div className={styles.map}>
          {map ? (
            <WorldMap
              fill
              operationalMap={map.operationalMap}
              cities={cities}
              nations={map.nations}
              myCityKey={context.here}
              focusKey={context.here}
              selectedKey={capital}
              onSelect={(key) => {
                const owner = cities.find((city) => city.key === key)?.nationId ?? null;
                if (owner !== null && allowed.has(owner)) onChange(String(owner));
              }}
            />
          ) : (
            <p className={styles.muted}>지도를 불러오는 중입니다</p>
          )}
        </div>
        <p className={styles.muted}>지도에서 그 국가의 도시를 누르거나 목록에서 고릅니다.</p>
        <p className={styles.route}>
          <span className={styles.tagPick}>선택 국가</span>{' '}
          {selectedNation ? <NationBadge name={selectedNation.name} color={selectedNation.color} /> : '고르지 않음'}
          {selectedNation ? <span className={styles.muted}> · {cityCount.get(selectedNation.id) ?? 0}성</span> : null}
        </p>
      </section>
      <section className={styles.listPane} aria-label={`${label} 목록`}>
        <div className={styles.list} role="radiogroup" aria-label={label}>
          {rows.length === 0 ? <p className={styles.muted}>고를 수 있는 국가가 없습니다</p> : null}
          {rows.map((nation) => (
            <button
              key={nation.id}
              type="button"
              role="radio"
              aria-checked={String(nation.id) === value}
              className={styles.row}
              onClick={() => onChange(String(nation.id))}
            >
              <NationBadge name={nation.name} color={nation.color} />
              <span className="num">{cityCount.get(nation.id) ?? 0}성</span>
              <span className={styles.muted}>
                {nation.capitalCityKey === null
                  ? '수도 없음'
                  : `수도 ${cities.find((city) => city.key === nation.capitalCityKey)?.name ?? '—'}`}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

// 장수 대상 고르기. 번호를 치지 않고 이름 목록에서 고른다.
export function GeneralTargetPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ id: number; name: string }>;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const listId = useId();
  const rows = options
    .filter((general) => query.trim() === '' || general.name.includes(query.trim()))
    .sort((a, b) => displayName(a.name).localeCompare(displayName(b.name), 'ko'));
  return (
    <section className={styles.single} aria-label={`${label} 목록`}>
      <label className={styles.find}>
        <span>{label} 찾기</span>
        <input type="search" value={query} aria-controls={listId} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div id={listId} className={`${styles.list} ${styles.columns}`} role="radiogroup" aria-label={label}>
        {rows.length === 0 ? <p className={styles.muted}>고를 수 있는 장수가 없습니다</p> : null}
        {rows.map((general) => (
          <button
            key={general.id}
            type="button"
            role="radio"
            aria-checked={String(general.id) === value}
            className={styles.row}
            onClick={() => onChange(String(general.id))}
          >
            <span className={styles.rowName}>{displayName(general.name)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// 병종 고르기. 병종표의 수치와 서버가 계산한 모집 조건 사유를 함께 보인다.
export function UnitPicker({
  label,
  value,
  options,
  onChange,
  context,
  note = null,
}: {
  context: ArgContext;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  note?: string | null;
}) {
  const unitSet = context.unitSet;
  const recruitment = context.recruitment;
  const allowed = new Set(options.map((option) => option.value));
  const rows = (unitSet?.crewTypes ?? []).filter((unit) => allowed.has(String(unit.id)));
  const armName = (armType: number) => unitSet?.armTypes[String(armType)] ?? '';
  return (
    <section className={styles.single} aria-label={`${label} 표`}>
      <table className={styles.table}>
        <caption className={styles.caption}>{label} · 100명당 비용</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">계열</th>
            <th scope="col" className="num">
              공격
            </th>
            <th scope="col" className="num">
              방어
            </th>
            <th scope="col" className="num">
              기동
            </th>
            <th scope="col" className="num">
              회피
            </th>
            <th scope="col" className="num">
              금
            </th>
            <th scope="col" className="num">
              쌀
            </th>
            <th scope="col">모집</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((unit) => {
            const failure = recruitment?.byCrewType[String(unit.id)] ?? null;
            const checked = String(unit.id) === value;
            return (
              <tr key={unit.id} data-checked={checked} data-blocked={failure !== null}>
                <th scope="row">
                  <label className={styles.unitName}>
                    <input
                      type="radio"
                      name="crew-type"
                      value={unit.id}
                      checked={checked}
                      onChange={() => onChange(String(unit.id))}
                    />
                    {unit.name}
                  </label>
                </th>
                <td>{armName(unit.armType)}</td>
                <td className="num">{unit.attack}</td>
                <td className="num">{unit.defence}</td>
                <td className="num">{unit.speed}</td>
                <td className="num">{unit.avoid}</td>
                <td className="num">{unit.cost}</td>
                <td className="num">{unit.rice}</td>
                <td className={failure ? styles.muted : styles.ok}>{failure ? failure.message : '가능'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {note ? (
        <p className={styles.muted} role="note">
          {note}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <div className={styles.fields} role="radiogroup" aria-label={label}>
          {options.map((option) => (
            <label key={option.value} className={styles.unitName}>
              <input
                type="radio"
                name="crew-type-fallback"
                value={option.value}
                checked={option.value === value}
                onChange={() => onChange(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : null}
    </section>
  );
}
