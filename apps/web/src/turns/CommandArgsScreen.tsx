import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorldMap as WorldMapData } from '../game/types';
import type { WorldUnitSet } from '../battleSim/unitChoices';
import { levelName, isCapital } from '../main/siteMarkers';
import { WorldMap } from '../main/WorldMap';
import { Portrait } from '../portrait/Portrait';
import { NationBadge } from '../ui/NationBadge';
import { Tag } from '../ui/Tag';
import {
  cityDistances,
  cityLabel,
  countText,
  displayName,
  groupByDistance,
  matchesName,
  nationFactsText,
  purseLine,
  sortGenerals,
  statLine,
  troopLine,
  type GeneralFacts,
} from './targets';
import styles from './CommandArgsScreen.module.css';

// 인자가 있는 명령의 입력 화면 (INT-25, D-085). 원작처럼 화면 전체를 덮는다.
// 주소는 바꾸지 않는다. Esc·명령 취소로 닫고 명령 다시 고르기로 카드 목록에 돌아간다.
// 값이 맞는지는 서버의 사전 검사와 실행이 판정한다. 화면은 고르기를 돕는 자료만 보인다.
// 자료는 편집기가 이미 받은 조회(지도·내 장수·병종표·국가·순위·외교)를 넘겨받는다. 없으면 그 줄을 빼고 목록만 보인다.

// 대상 장수 카드 자료. 이름은 예턴 연결(인사부 조회)이, 수치는 같은 국가 장수 상세(nation.get)가 준다.
export interface TargetGeneral extends GeneralFacts {
  portraitId?: number | null | undefined;
  cityName?: string | undefined;
}

export interface NationFacts {
  power: number;
  cities: number;
  generals: number;
}

export interface ArgContext {
  map?: WorldMapData | undefined;
  here: number | null;
  ownNationId: number | null;
  wallet?: { gold: number; rice: number } | undefined;
  // 국가 예턴이면 안내 줄에 내 금·쌀 대신 국고를 적는다.
  walletKind?: 'general' | 'nation' | undefined;
  treasury?: { gold: number; rice: number } | undefined;
  unitSet?: WorldUnitSet | undefined;
  recruitment?: { byCrewType: Record<string, { message: string } | null> } | undefined;
  // 모병·징병 현황 줄 (home.get의 내 장수·국가).
  me?: { id: number; leadership: number; crew: number; crewType: number; gold: number } | undefined;
  tech?: number | undefined;
  // 내 도시 치안 (장비매매의 요구 치안과 견준다).
  security?: number | undefined;
  // 같은 국가 장수 상세. 대상 장수 카드의 능력치·병력·물자다.
  members?: readonly TargetGeneral[] | undefined;
  // 국가별 국력·도시·장수 (순위 조회). 순위 기록이 없으면 비어 있다.
  nationFacts?: ReadonlyMap<number, NationFacts> | undefined;
  // 우리와의 관계와 남은 기간 (조약 조회). 조약을 쓰지 않는 월드는 비어 있다.
  relations?: ReadonlyMap<number, string> | undefined;
}

const num = (value: number) => value.toLocaleString('ko-KR');

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

  const nation = context.walletKind === 'nation';
  const purse = nation ? context.treasury : context.wallet;
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
        {purse ? (
          <span className={styles.wallet} data-testid={nation ? 'args-treasury' : 'args-wallet'}>
            {nation ? '국고 금' : '내 금'} <span className="num">{num(purse.gold)}</span> · 쌀{' '}
            <span className="num">{num(purse.rice)}</span>
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

// 국가색 견본. 이름은 옆 글자가 적으므로 읽지 않는다.
function Swatch({ color }: { color: string | null | undefined }) {
  return (
    <span
      className={styles.swatch}
      style={color ? { background: color } : undefined}
      data-empty={color ? undefined : 'true'}
      aria-hidden="true"
    />
  );
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
  ownFirst = false,
}: {
  context: ArgContext;
  label: string;
  value: string;
  options: readonly CityOption[];
  note: string | null;
  onChange: (value: string) => void;
  // 발령·천도·백성동원처럼 내 국가 도시가 대상인 명령은 내 도시를 먼저 둔다.
  ownFirst?: boolean;
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
  const pool = useMemo(() => cities.filter((city) => allowed.has(city.key)), [cities, allowed]);
  const candidates = useMemo(() => pool.filter((city) => matchesName(city.name, query)), [pool, query]);
  const groups = useMemo(
    () => groupByDistance(candidates, distances, ownNation, ownFirst),
    [candidates, distances, ownNation, ownFirst],
  );
  const selected = cities.find((city) => String(city.key) === value) ?? null;
  const herCity = cities.find((city) => city.key === here) ?? null;
  const pick = (key: number) => {
    if (allowed.has(key)) onChange(String(key));
  };
  const nationOf = (city: { nationId: number | null }) =>
    city.nationId === null ? undefined : nationById.get(city.nationId);
  const describe = (city: { key: number; level: number; nationId: number | null }) => {
    const nation = nationOf(city);
    const distance = distances.get(city.key);
    return [
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
          <span className={styles.tagHere}>현재 도시</span>{' '}
          {herCity ? cityLabel(herCity.name, nationOf(herCity)?.name) : '—'} →{' '}
          <span className={styles.tagPick}>선택 도시</span>{' '}
          {selected ? cityLabel(selected.name, nationOf(selected)?.name) : '고르지 않음'}
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
          <input
            type="search"
            value={query}
            placeholder="이름 또는 초성"
            aria-controls={listId}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className={styles.count}>{countText(candidates.length, pool.length, query)}</span>
        </label>
        <div id={listId} className={styles.list} role="radiogroup" aria-label={label}>
          {groups.length === 0 ? <p className={styles.muted}>고를 수 있는 도시가 없습니다</p> : null}
          {groups.map((group) => (
            <div key={group.distance ?? 'none'} className={styles.group}>
              <p className={styles.groupHead}>
                {group.distance === null ? '연결 없음' : group.distance === 0 ? '현재 도시' : `${group.distance}칸`} ·{' '}
                {group.items.length}곳
              </p>
              {group.items.map((city) => {
                const nation = nationOf(city);
                const own = ownNation !== null && city.nationId === ownNation;
                const level = levelName(city.level);
                return (
                  <button
                    key={city.key}
                    type="button"
                    role="radio"
                    data-value={city.key}
                    aria-checked={String(city.key) === value}

                    className={styles.row}
                    onClick={() => pick(city.key)}
                  >
                    <span className={styles.rowName}>
                      <Swatch color={nation?.color} />
                      {cityLabel(city.name, nation?.name)}
                    </span>
                    <span className={styles.muted}>
                      {[level, isCapital(city, nation) ? '수도' : null].filter(Boolean).join(' · ')}
                    </span>
                    {own ? <Tag tone="muted">아국</Tag> : <span />}
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

// 대상 국가 후보마다의 사전 검사 결과. 서버가 판정하고 화면은 결과만 보인다.
export type CandidateCheck = { ok: true } | { ok: false; message: string };

// 국가 대상 고르기. 지도에서 도시를 누르면 그 도시의 국가를 고른다.
// 후보 카드는 국가색·이름·`수도 X · 국력 N · 도시 N · 장수 N`과 우리와의 관계, 사전 검사 결과다.
export function NationTargetPicker({
  label,
  value,
  options,
  onChange,
  context,
  checks,
}: {
  context: ArgContext;
  label: string;
  value: string;
  options: ReadonlyArray<{ id: number; name: string }>;
  onChange: (value: string) => void;
  // 있으면 후보마다 가능·불가를 붙이고 가능한 국가를 앞에 둔다.
  checks?: ReadonlyMap<number, CandidateCheck> | undefined;
}) {
  const [query, setQuery] = useState('');
  const listId = useId();
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
  const facts = context.nationFacts;
  const relations = context.relations;
  const power = (id: number) => facts?.get(id)?.power ?? -1;
  const blocked = (id: number) => (checks?.get(id)?.ok === false ? 1 : 0);
  const pool = nations.filter((nation) => allowed.has(nation.id));
  const rows = pool
    .filter((nation) => matchesName(nation.name, query))
    .sort(
      (a, b) =>
        blocked(a.id) - blocked(b.id) ||
        power(b.id) - power(a.id) ||
        (cityCount.get(b.id) ?? 0) - (cityCount.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name, 'ko'),
    );
  const selectedNation = nations.find((nation) => String(nation.id) === value);
  const capital = selectedNation?.capitalCityKey ?? null;
  const cardText = (nation: { id: number; capitalCityKey: number | null }) => {
    const known = facts?.get(nation.id);
    return nationFactsText({
      capital:
        nation.capitalCityKey === null
          ? null
          : (cities.find((city) => city.key === nation.capitalCityKey)?.name ?? '—'),
      power: known?.power,
      cities: known?.cities ?? cityCount.get(nation.id) ?? 0,
      generals: known?.generals,
    });
  };
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
          {selectedNation ? (
            <span className={styles.muted}>
              {' '}
              · {cardText(selectedNation)}
              {relations?.get(selectedNation.id) ? ` · ${relations.get(selectedNation.id)}` : ''}
            </span>
          ) : null}
        </p>
      </section>
      <section className={styles.listPane} aria-label={`${label} 목록`}>
        <label className={styles.find}>
          <span>{label} 찾기</span>
          <input
            type="search"
            value={query}
            placeholder="이름 또는 초성"
            aria-controls={listId}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className={styles.count}>{countText(rows.length, pool.length, query)}</span>
        </label>
        <div id={listId} className={styles.list} role="radiogroup" aria-label={label}>
          {rows.length === 0 ? <p className={styles.muted}>고를 수 있는 국가가 없습니다</p> : null}
          {rows.map((nation) => {
            const check = checks?.get(nation.id);
            const relation = relations?.get(nation.id);
            return (
              <button
                key={nation.id}
                type="button"
                role="radio"
                data-value={nation.id}
                aria-checked={String(nation.id) === value}
                className={`${styles.row} ${styles.cardRow}`}
                data-blocked={check?.ok === false ? 'true' : undefined}
                onClick={() => onChange(String(nation.id))}
              >
                <span className={styles.cardHead}>
                  <NationBadge name={nation.name} color={nation.color} />
                  {relation ? <span className={styles.muted}>{relation}</span> : null}
                  {check ? check.ok ? <Tag tone="info">가능</Tag> : <Tag tone="warning">불가</Tag> : null}
                </span>
                <span className={styles.cardLine}>{cardText(nation)}</span>
                {check && !check.ok ? <span className={styles.reason}>{check.message}</span> : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// 장수 대상 고르기. 번호를 치지 않고 얼굴·이름 목록에서 고른다.
// 같은 국가 장수는 소재 도시·능력치·병력·물자를 함께 보이고, 포상은 물자가 적은 순, 몰수는 많은 순으로 둔다.
export function GeneralTargetPicker({
  label,
  value,
  options,
  onChange,
  order = null,
}: {
  label: string;
  value: string;
  options: readonly TargetGeneral[];
  onChange: (value: string) => void;
  order?: { resource: 'gold' | 'rice'; direction: 'asc' | 'desc' } | null;
}) {
  const [query, setQuery] = useState('');
  const listId = useId();
  const pool = options.filter((general) => matchesName(displayName(general.name), query));
  const rows = sortGenerals(pool, order, (general) => displayName(general.name));
  const selected = options.find((general) => String(general.id) === value) ?? null;
  const title = (general: TargetGeneral) =>
    general.cityName ? `${displayName(general.name)} (${general.cityName})` : displayName(general.name);
  return (
    <section className={styles.single} aria-label={`${label} 목록`}>
      {selected ? (
        <div className={styles.picked} data-testid="picked-general">
          <span aria-hidden="true">
            <Portrait
              id={selected.portraitId ?? null}
              name={displayName(selected.name)}
              variant="icon"
              shape="round"
              className={styles.pickedFace}
            />
          </span>
          <div className={styles.pickedText}>
            <strong>{title(selected)}</strong>
            {[statLine(selected), troopLine(selected), purseLine(selected)].map((line, i) =>
              line ? <span key={i}>{line}</span> : null,
            )}
          </div>
        </div>
      ) : null}
      <label className={styles.find}>
        <span>{label} 찾기</span>
        <input
          type="search"
          value={query}
          placeholder="이름 또는 초성"
          aria-controls={listId}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={styles.count}>{countText(pool.length, options.length, query)}</span>
      </label>
      <div id={listId} className={`${styles.list} ${styles.generalColumns}`} role="radiogroup" aria-label={label}>
        {rows.length === 0 ? <p className={styles.muted}>고를 수 있는 장수가 없습니다</p> : null}
        {rows.map((general) => {
          const stats = statLine(general);
          const second = [order ? purseLine(general) : troopLine(general)].filter(Boolean).join('');
          return (
            <button
              key={general.id}
              type="button"
              role="radio"
              data-value={general.id}
              aria-checked={String(general.id) === value}
              className={`${styles.row} ${styles.generalRow}`}
              onClick={() => onChange(String(general.id))}
            >
              <span aria-hidden="true" className={styles.faceBox}>
                <Portrait
                  id={general.portraitId ?? null}
                  name={displayName(general.name)}
                  variant="icon"
                  shape="round"
                  className={styles.face}
                />
              </span>
              <span className={styles.generalText}>
                <span className={styles.rowName}>
                  {title(general)}
                  {general.isHuman === false ? (
                    <>
                      {' '}
                      <Tag tone="muted">NPC</Tag>
                    </>
                  ) : null}
                </span>
                {stats ? <span className={styles.cardLine}>{stats}</span> : null}
                {second ? <span className={styles.cardLine}>{second}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// 병종 고르기. 병종표의 수치와 서버가 계산한 모집 조건 사유를 함께 보인다.
// 표 위에 지금 통솔·최대 병력·병종·병력·금·기술을 한 줄로 둔다. 못 고르는 병종은 흐리게 두고 사유를 같은 줄에 적는다.
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
  // 병과별로 묶는다. 병종표 순서를 그대로 쓴다.
  const arms = [...new Set(rows.map((unit) => unit.armType))];
  const me = context.me;
  const unitName = (id: number) => unitSet?.crewTypes.find((unit) => unit.id === id)?.name;
  const status = me
    ? [
        `통솔 ${me.leadership}(최대 병력 ${num(me.leadership * 100)})`,
        me.crew > 0 ? `현재 병종 ${unitName(me.crewType) ?? `병종 ${me.crewType}`}` : '현재 병종 없음',
        `현재 병력 ${num(me.crew)}`,
        `금 ${num(me.gold)}`,
        context.tech === undefined ? null : `국가 기술 ${num(context.tech)}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  return (
    <section className={styles.single} aria-label={`${label} 표`}>
      {status ? (
        <p className={styles.status} data-testid="recruit-status">
          {status}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div role="radiogroup" aria-label={label} className={styles.tableBox}>
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
            {arms.map((arm) => (
              <tbody key={arm}>
                {arms.length > 1 && armName(arm) ? (
                  <tr className={styles.armHead}>
                    <th scope="rowgroup" colSpan={9}>
                      {armName(arm)} 계열
                    </th>
                  </tr>
                ) : null}
                {rows
                  .filter((unit) => unit.armType === arm)
                  .map((unit) => {
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
                        <td>
                          {failure ? (
                            <span className={styles.blockedCell}>
                              <Tag tone="warning">불가</Tag> {failure.message}
                            </span>
                          ) : (
                            <span className={styles.ok}>가능</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            ))}
          </table>
        </div>
      ) : null}
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

// 수량 칸 아래의 빠른 입력. 모병·징병은 통솔 한도까지의 절반·채우기, 그 밖은 자주 쓰는 값과 가진 만큼이다.
// 예상 금은 서버 사전 검사의 미리보기를 그대로 적는다 (preview 자리).
export function AmountHelpers({
  label,
  buttons,
  onPick,
  preview,
}: {
  label: string;
  buttons: ReadonlyArray<{ text: string; value: number }>;
  onPick: (value: number) => void;
  preview?: ReactNode;
}) {
  if (buttons.length === 0 && !preview) return null;
  return (
    <div className={styles.amountRow}>
      {buttons.length > 0 ? (
        <div className={styles.quick} role="group" aria-label={`${label} 빠른 입력`}>
          {buttons.map((button) => (
            <button key={button.text} type="button" className={styles.quickButton} onClick={() => onPick(button.value)}>
              {button.text}
            </button>
          ))}
        </div>
      ) : null}
      {preview}
    </div>
  );
}
