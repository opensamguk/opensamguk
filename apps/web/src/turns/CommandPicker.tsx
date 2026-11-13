import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorldUnits } from '../battleSim/unitChoices';
import { DisabledReason } from '../ui/DisabledReason';
import { argFields, buildArgs, describeArgs, requiredKeys, type ArgField } from './args';
import {
  CityTargetPicker,
  CommandArgsScreen,
  GeneralTargetPicker,
  NationTargetPicker,
  UnitPicker,
  type ArgContext,
} from './CommandArgsScreen';
import type { Turn } from './draft';
import type { Check, SourceQuery } from './source';
import styles from './TurnEditor.module.css';
import { cityPreparationNote, cityPreparationSchema, hasCityBranch, type PreparationTarget } from './cityResourceArgs';
import { EquipmentTradeFields, equipmentUiSchema } from '../equipment/EquipmentTradeFields';
import type { EquipmentRead } from '../equipment/useEquipment';

export interface CommandInfo {
  key: string;
  name: string;
  category: string;
  argsSchema: unknown;
}

export const CATEGORY_LABELS: Record<string, string> = {
  domestic: '내정',
  military: '군사',
  strategy: '전략',
  personal: '개인',
  nation: '국가',
};
const CATEGORY_ORDER = ['domestic', 'military', 'strategy', 'personal', 'nation'];

// 명령마다 대상 도시 후보를 바꿀 때 쓴다 (교역 대상, T2-08). note는 후보가 없을 때의 이유 같은 안내다.
export interface CityChoices {
  options: Array<{ key: number; name: string }>;
  note: string | null;
}

interface Props {
  commands: CommandInfo[];
  cities: Array<{ key: number; name: string }>;
  nations: Array<{ id: number; name: string }>;
  // 있으면 대상 장수(generalId)를 이름으로 고른다 (국가 칸, T2-06).
  generals?: Array<{ id: number; name: string }> | undefined;
  selectedCityKey: number | null;
  // 지금 거느린 병종. 병종 칸 기본값의 첫 후보다.
  defaultCrewType: number | undefined;
  // 월드 병종표 (T4-86). 불러오는 중·오류면 빈 목록이고 unitNote가 이유다. 병종 없는 명령은 그대로 넣을 수 있다.
  units: WorldUnits;
  unitNote?: string | null | undefined;
  recruitment?: { city: string } | undefined;
  cityResources?: boolean;
  equipment?: EquipmentRead | undefined;
  // 넣을 수 없을 때의 이유. null이면 넣을 수 있다.
  blockedReason: string | null;
  targetLabel: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onPut: (turn: Turn) => void;
  onSave?: (turn: Turn) => void;
  // 없거나 null을 돌려주면 지도의 모든 도시가 후보다.
  cityChoicesFor?: ((commandKey: string) => CityChoices | null) | undefined;
  // 있으면 고른 명령을 넣기 전에 서버 사전 검사를 받아 경고를 미리 보인다. 30칸 표와 같은 조회 키라 캐시를 같이 쓴다.
  precheck?: ((turn: Turn) => SourceQuery<Check>) | undefined;
  // 인자 입력 화면이 쓰는 지도·내 장수·병종표 (INT-25). 없으면 지도 없이 목록만 보인다.
  argContext?: ArgContext | undefined;
}

// 서버가 준 명령을 카드로 고른다. 카드 선택과 실제 명령/패 소비는 별개다.
// 키보드: 검색 칸에서 Enter를 누르면 화면의 첫 카드를 고른다. 인자가 없으면 바로 넣고, 있으면 첫 인자 칸으로 간다.
export function CommandPicker({
  commands,
  cities,
  nations,
  generals,
  selectedCityKey,
  defaultCrewType,
  units,
  unitNote = null,
  recruitment,
  cityResources = false,
  equipment,
  blockedReason,
  targetLabel,
  searchRef,
  onPut,
  onSave,
  cityChoicesFor,
  precheck,
  argContext = { here: null, ownNationId: null },
}: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [chosen, setChosen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preparationTarget, setPreparationTarget] = useState<PreparationTarget>('unit');
  const firstArgRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const formId = useId();

  // 서버 목록에서 고른 명령이 빠지면 고른 상태와 입력값을 비운다. 같은 키가 다시 와도 옛 입력을 되살리지 않는다.
  if (chosen !== null && !commands.some((c) => c.key === chosen)) {
    setChosen(null);
    setValues({});
    setPreparationTarget('unit');
  }

  // 고른 카드만 고른 갈래를 쓰고, 나머지 카드는 기본 갈래(기존 부곡)로 설명한다.
  const targetOf = (key: string): PreparationTarget => (key === chosen ? preparationTarget : 'unit');
  const schemaFor = (item: CommandInfo, target: PreparationTarget) =>
    item.key === 'equipment_trade' ? equipmentUiSchema : cityPreparationSchema(item.argsSchema, cityResources, target);
  // 국가 칸은 대상 장수를 이름으로 고르므로 카드 설명·입력 칸·누락 안내가 같은 이름을 쓴다.
  const fieldsFor = (target: unknown): ArgField[] =>
    target
      ? argFields(target, units.all).map((field) => {
          if (field.key === 'generalId' && generals) return { ...field, label: '대상 장수' };
          return field;
        })
      : [];

  const categories = useMemo(
    () =>
      [...new Set([...CATEGORY_ORDER, ...commands.map((command) => command.category)])].filter((key) =>
        commands.some((command) => command.category === key),
      ),
    [commands],
  );
  const activeCategory = categories.includes(category) ? category : 'all';

  const filtered = useMemo(() => {
    const q = query.trim();
    return commands.filter(
      (command) =>
        (activeCategory === 'all' || command.category === activeCategory) && (q === '' || command.name.includes(q)),
    );
  }, [commands, query, activeCategory]);
  // 화면은 분류 순서로 묶어 그린다. 검색 Enter도 이 순서의 첫 카드를 고른다.
  const groups = useMemo(
    () =>
      categories
        .map((key) => ({ key, items: filtered.filter((c) => c.category === key) }))
        .filter((g) => g.items.length > 0),
    [categories, filtered],
  );
  const command = commands.find((c) => c.key === chosen) ?? null;
  const schema = command ? schemaFor(command, preparationTarget) : null;
  const fields = command ? fieldsFor(schema) : [];
  const required = schema ? requiredKeys(schema) : [];
  // 도시 자원 판에서 서버 schema에 도시 수비병 갈래가 있는 명령(INT-18의 훈련·사기)만 갈래를 고른다.
  // 고른 뒤 서버 목록에서 갈래가 사라져도 부곡으로 되돌릴 수 있도록 고른 상태면 선택 칸을 남긴다.
  const cityDrill = cityResources && command && (hasCityBranch(command.argsSchema) || preparationTarget === 'city');
  const costNote = command ? cityPreparationNote(cityResources, command.key, preparationTarget) : null;
  const built = buildArgs(fields, required, values);
  const sortedCities = useMemo(() => [...cities].sort((a, b) => a.name.localeCompare(b.name, 'ko')), [cities]);
  const choices = command && cityChoicesFor ? cityChoicesFor(command.key) : null;
  const cityOptions = choices?.options ?? sortedCities;
  // 지도에서 고른 도시는 후보 안에 있을 때만 기본값과 되돌리기 힌트로 쓴다.
  const mapCityFor = (key: string | undefined) => {
    if (selectedCityKey === null) return null;
    const limited = key ? cityChoicesFor?.(key) : null;
    return !limited || limited.options.some((c) => c.key === selectedCityKey) ? selectedCityKey : null;
  };

  // 고를 때 기본값을 채운다. 대상 도시는 지도에서 고른 도시를 먼저 둔다 (힌트일 뿐 바로 넣지는 않는다).
  // 다른 카드로 옮기면 훈련·사기 갈래는 기존 부곡으로 돌아간다. 고른 schema를 돌려준다.
  const choose = (key: string, target: PreparationTarget = targetOf(key)) => {
    setChosen(key);
    setPreparationTarget(target);
    const next = commands.find((c) => c.key === key);
    const initial: Record<string, string> = {};
    const mapCity = mapCityFor(next?.key);
    const nextSchema = next ? schemaFor(next, target) : null;
    for (const field of fieldsFor(nextSchema)) {
      if (field.kind === 'city' && mapCity !== null) initial[field.key] = String(mapCity);
      // 지금 거느린 병종을 먼저 고른다(병력이 있으면 소집해제 전엔 바꿀 수 없다). 없으면 월드 기본 병종, 첫 장수 병종 순이다.
      if (field.kind === 'unit') {
        const own = defaultCrewType == null ? undefined : String(defaultCrewType);
        const fallback = units.defaultId === undefined ? undefined : String(units.defaultId);
        initial[field.key] =
          [own, fallback].find((v) => field.options.some((o) => o.value === v)) ?? field.options[0]?.value ?? '';
      }
      if (field.kind === 'boolean') initial[field.key] = 'true';
      if (field.kind === 'enum') initial[field.key] = field.options[0]?.value ?? '';
      if (field.kind === 'color') initial[field.key] = '#8a5a2b';
    }
    setValues(initial);
    return nextSchema;
  };

  // 장비 정보가 준비되지 않았으면 이미 고른 인자가 남아 있어도 넣거나 미리 검사하지 않는다.
  const equipmentWait =
    command?.key === 'equipment_trade' && equipment?.kind !== 'ready'
      ? equipment?.kind === 'error'
        ? '장비 정보를 불러오지 못했습니다. 다시 시도하세요.'
        : '장비 정보를 불러오는 중입니다.'
      : null;
  // 지금 넣으면 들어갈 명령. 칸이 덜 찼거나 형식을 모르면 없다.
  const ready: Turn | null =
    command && schema && equipmentWait === null && built.missing.length === 0
      ? {
          commandKey: command.key,
          args: cityDrill && preparationTarget === 'city' ? { ...built.args, target: 'city' } : built.args,
          explicit: true,
        }
      : null;
  const put = (save = true) => {
    if (!ready || blockedReason) return;
    (save && onSave ? onSave : onPut)(ready);
    // 인자 입력 화면은 넣은 뒤 닫는다. 인자 없는 명령은 카드 고른 상태를 그대로 둔다.
    if (needsScreen) close();
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = groups[0]?.items[0];
    if (!first) return;
    const nextSchema = choose(first.key);
    if (nextSchema && !(cityResources && hasCityBranch(first.argsSchema)) && fieldsFor(nextSchema).length === 0) {
      if (!blockedReason) onPut({ commandKey: first.key, args: {}, explicit: true });
    } else {
      // 인자 칸이 그려진 뒤 옮긴다.
      requestAnimationFrame(() => firstArgRef.current?.focus());
    }
  };

  const onArgKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      put();
    }
  };

  const putReason =
    blockedReason ??
    (!command
      ? '명령을 고르세요.'
      : !schema
        ? '명령 입력 형식을 확인하지 못했습니다.'
        : equipmentWait !== null
          ? equipmentWait
          : built.missing.length > 0
            ? `${built.missing.join(', ')} 칸을 채우세요.`
            : null);

  // 인자가 있는 명령은 원작처럼 화면 전체의 입력 화면에서 고른다 (INT-25).
  const needsScreen = Boolean(
    command && schema && (fields.length > 0 || cityDrill || command.key === 'equipment_trade'),
  );
  const close = () => {
    setChosen(null);
    setValues({});
    setPreparationTarget('unit');
  };
  const reselect = () => {
    close();
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  const summary = command
    ? [
        command.name,
        describeArgs(built.args, {
          city: (key) => cities.find((c) => c.key === key)?.name,
          nation: (id) => nations.find((n) => n.id === id)?.name,
          general: generals ? (id) => generals.find((g) => g.id === id)?.name : undefined,
          unit: (id) => units.name(id),
        }),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const putButton = (
    <>
      {onSave ? (
        putReason === null ? (
          <button
            type={needsScreen ? 'submit' : 'button'}
            form={formId}
            className={styles.primary}
            onClick={needsScreen ? undefined : () => put()}
          >
            {targetLabel}에 저장
          </button>
        ) : (
          <DisabledReason reason={putReason}>{targetLabel}에 저장</DisabledReason>
        )
      ) : null}
      {putReason === null ? (
        <button
          type="button"
          className={onSave ? styles.secondary : styles.primary}
          onClick={() => put(false)}
          title={onSave ? '초안에만 넣습니다. 나중에 함께 저장할 수 있습니다.' : undefined}
        >
          {targetLabel}에 넣기
        </button>
      ) : (
        <DisabledReason reason={putReason}>{targetLabel}에 넣기</DisabledReason>
      )}
    </>
  );

  return (
    <section className={styles.picker} aria-label="명령 고르기">
      <div className={styles.pickerHead}>
        <label className={styles.search}>
          <span>명령 찾기</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="이름으로 찾기, Enter로 고르기"
            aria-controls={listId}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
        </label>
        <div className={styles.categories} role="group" aria-label="명령 분류">
          {['all', ...categories].map((key) => (
            <button
              key={key}
              type="button"
              className={styles.chip}
              aria-pressed={activeCategory === key}
              onClick={() => setCategory(key)}
            >
              {key === 'all' ? '전체' : (CATEGORY_LABELS[key] ?? key)}
            </button>
          ))}
        </div>
      </div>

      <div id={listId} className={styles.commandList}>
        {groups.length === 0 ? (
          <p className={styles.muted}>맞는 명령이 없습니다. 검색어를 지우거나 전체 분류를 고르세요.</p>
        ) : null}
        {groups.map((group) => (
          <fieldset key={group.key} className={styles.group}>
            <legend>{CATEGORY_LABELS[group.key] ?? group.key}</legend>
            <div className={styles.commandCards}>
              {group.items.map((item) => {
                const cardSchema = schemaFor(item, targetOf(item.key));
                const cardFields = fieldsFor(cardSchema);
                const cardRequired = requiredKeys(cardSchema);
                const cardId = `${listId}-${item.key}`;
                return (
                  <label key={item.key} className={styles.commandOption} data-checked={chosen === item.key}>
                    <input
                      type="radio"
                      name={`${listId}-command`}
                      value={item.key}
                      checked={chosen === item.key}
                      aria-labelledby={`${cardId}-name`}
                      aria-describedby={`${cardId}-hint`}
                      onChange={() => choose(item.key)}
                    />
                    <span className={styles.commandBody}>
                      <strong id={`${cardId}-name`}>{item.name}</strong>
                      <span id={`${cardId}-hint`} className={styles.commandHint}>
                        {CATEGORY_LABELS[item.category] ?? item.category}
                        {' · '}
                        {!cardSchema
                          ? '입력 형식 확인 필요'
                          : cardFields
                              .map((field) => `${field.label}${cardRequired.includes(field.key) ? ' (필수)' : ''}`)
                              .join(' · ') || '고를 것 없음'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {command && !needsScreen ? (
        <div className={styles.argForm}>
          {schema ? <p className={styles.muted}>더 고를 것 없이 바로 넣는 명령입니다.</p> : null}
          {ready && precheck && ready.commandKey !== 'rest' ? <PrecheckWarning query={precheck(ready)} /> : null}
        </div>
      ) : null}

      {command && needsScreen ? (
        <CommandArgsScreen
          context={argContext}
          title={command.name}
          slotLabel={targetLabel}
          onCancel={close}
          onReselect={reselect}
          summary={summary}
          notes={
            <>
              {costNote ? <p role="note">{costNote}</p> : null}
              {/* 휴식과 장비매매는 위 카드·표가 이미 판정을 보인다. */}
              {ready && precheck && ready.commandKey !== 'rest' && ready.commandKey !== 'equipment_trade' ? (
                <PrecheckWarning query={precheck(ready)} />
              ) : null}
            </>
          }
          putButton={putButton}
        >
          <form
            id={formId}
            className={styles.argScreenForm}
            aria-label={`${command.name} 인자`}
            onSubmit={(e) => {
              e.preventDefault();
              put();
            }}
          >
            {cityDrill ? (
              <label className={styles.argLabel}>
                <span>훈련·사기 대상</span>
                <select
                  value={preparationTarget}
                  onChange={(event) => {
                    choose(command.key, event.target.value === 'city' ? 'city' : 'unit');
                  }}
                >
                  <option value="unit">기존 부곡</option>
                  <option value="city">현재 도시 수비병</option>
                </select>
              </label>
            ) : null}
            {command.key === 'equipment_trade' ? (
              <div className={styles.argScreenPanel}>
                <EquipmentTradeFields read={equipment} values={values} onChange={setValues} firstArgRef={firstArgRef} />
              </div>
            ) : (
              <>
                <div className={`${styles.argScreenFields} ${styles.argScreenPanel}`}>
                  {fields
                    .filter(
                      (field) =>
                        field.kind !== 'city' &&
                        field.kind !== 'nation' &&
                        field.kind !== 'unit' &&
                        !(field.key === 'generalId' && generals),
                    )
                    .map((field, i) => (
                      <ArgInput
                        key={field.key}
                        field={field}
                        value={values[field.key] ?? ''}
                        cities={cityOptions}
                        nations={nations}
                        generals={generals}
                        inputRef={i === 0 ? firstArgRef : undefined}
                        onKeyDown={onArgKey}
                        onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                        note={field.kind === 'unit' && field.options.length === 0 ? unitNote : null}
                        mapHint={null}
                      />
                    ))}
                </div>
                {fields.map((field) => {
                  const set = (value: string) => setValues((prev) => ({ ...prev, [field.key]: value }));
                  const value = values[field.key] ?? '';
                  if (field.kind === 'city')
                    return (
                      <CityTargetPicker
                        key={field.key}
                        context={argContext}
                        label={field.label}
                        value={value}
                        options={cityOptions}
                        note={choices?.note ?? null}
                        onChange={set}
                      />
                    );
                  if (field.kind === 'nation')
                    return (
                      <NationTargetPicker
                        key={field.key}
                        context={argContext}
                        label={field.label}
                        value={value}
                        options={nations}
                        onChange={set}
                      />
                    );
                  if (field.key === 'generalId' && generals)
                    return (
                      <GeneralTargetPicker
                        key={field.key}
                        label={field.label}
                        value={value}
                        options={generals}
                        onChange={set}
                      />
                    );
                  if (field.kind === 'unit')
                    return (
                      <UnitPicker
                        key={field.key}
                        context={argContext}
                        label={field.label}
                        value={value}
                        options={field.options}
                        note={
                          recruitment && (command.key === 'recruit' || command.key === 'conscript')
                            ? `${recruitment.city}의 현재 모집 조건을 확인할 수 있습니다.`
                            : field.options.length === 0
                              ? unitNote
                              : null
                        }
                        onChange={set}
                      />
                    );
                  return null;
                })}
              </>
            )}
          </form>
        </CommandArgsScreen>
      ) : null}

      {!needsScreen ? <div className={styles.putRow}>{putButton}</div> : null}
    </section>
  );
}

function ArgInput({
  field,
  value,
  cities,
  nations,
  generals,
  inputRef,
  onChange,
  onKeyDown,
  note,
  mapHint,
}: {
  field: ArgField;
  value: string;
  cities: Array<{ key: number; name: string }>;
  nations: Array<{ id: number; name: string }>;
  generals: Array<{ id: number; name: string }> | undefined;
  inputRef: RefObject<HTMLElement | null> | undefined;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  note: string | null;
  mapHint: { name: string; use: () => void } | null;
}) {
  const ref = inputRef as RefObject<HTMLInputElement & HTMLSelectElement> | undefined;
  let control;
  if (field.key === 'generalId' && generals) {
    control = (
      <select ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}>
        <option value="">고르세요</option>
        {generals.map((g) => (
          <option key={g.id} value={String(g.id)}>
            {g.name}
          </option>
        ))}
      </select>
    );
  } else if (
    field.kind === 'city' ||
    field.kind === 'nation' ||
    field.kind === 'boolean' ||
    field.kind === 'enum' ||
    field.kind === 'unit'
  ) {
    const options =
      field.kind === 'city'
        ? cities.map((c) => ({ value: String(c.key), label: c.name }))
        : field.kind === 'nation'
          ? nations.map((n) => ({ value: String(n.id), label: n.name }))
          : field.kind === 'boolean'
            ? [
                { value: 'true', label: field.options[0] },
                { value: 'false', label: field.options[1] },
              ]
            : field.options;
    control = (
      <select ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}>
        {/* 병종표를 늦게 받아 고른 값이 없으면 첫 병종이 고른 것처럼 보이지 않게 빈 선택을 둔다. */}
        {field.kind === 'city' ||
        field.kind === 'nation' ||
        (field.kind === 'unit' && !field.options.some((option) => option.value === value)) ? (
          <option value="">고르세요</option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.kind === 'integer') {
    control = (
      <input
        ref={ref}
        type="number"
        inputMode="numeric"
        min={field.min}
        max={field.max}
        step={1}
        value={value}
        className="num"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    );
  } else if (field.kind === 'color') {
    control = (
      <input ref={ref} type="color" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
    );
  } else {
    control = (
      <input
        ref={ref}
        type="text"
        maxLength={field.maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    );
  }
  return (
    <div className={styles.argRow}>
      <label className={styles.argLabel}>
        <span>{field.label}</span>
        {control}
      </label>
      {mapHint ? (
        <button type="button" className={styles.linkButton} onClick={mapHint.use}>
          지도에서 고른 도시({mapHint.name}) 쓰기
        </button>
      ) : null}
      {note ? (
        <p className={styles.muted} role="note">
          {note}
        </p>
      ) : null}
    </div>
  );
}

// 넣기 전 사전 검사 경고. 판정은 서버가 하고 화면은 결과만 보인다. 통과하거나 아직 모르면 아무것도 그리지 않는다.
// 고를 때 새로 나타나므로 status로 알린다. 편집기의 note는 넣기·저장 불가 사유 하나로 둔다.
function PrecheckWarning({ query }: { query: SourceQuery<Check> }) {
  const check = useQuery({ queryKey: query.queryKey, queryFn: query.queryFn, select: query.select, retry: false });
  if (!check.data || check.data.ok) return null;
  return (
    <p className={styles.warn} role="status">
      사전 검사 경고: {check.data.message} 경고가 있어도 넣을 수 있습니다. 실행할 때 다시 검사합니다.
    </p>
  );
}
