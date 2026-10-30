import { useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { DisabledReason } from '../ui/DisabledReason';
import { argFields, buildArgs, requiredKeys, type ArgField } from './args';
import type { Turn } from './draft';
import styles from './TurnEditor.module.css';
import { cityPreparationNote, cityPreparationSchema, type PreparationTarget } from './cityResourceArgs';

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
  defaultCrewType: number | undefined;
  cityResources?: boolean;
  // 넣을 수 없을 때의 이유. null이면 넣을 수 있다.
  blockedReason: string | null;
  targetLabel: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onPut: (turn: Turn) => void;
  // 없거나 null을 돌려주면 지도의 모든 도시가 후보다.
  cityChoicesFor?: ((commandKey: string) => CityChoices | null) | undefined;
}

// 명령 고르기: 분류별 목록 + 이름 검색, 인자가 있으면 대상 칸을 띄운다.
// 키보드: 검색 칸에서 Enter를 누르면 첫 결과를 고른다. 인자가 없으면 바로 넣고, 있으면 첫 인자 칸으로 간다.
export function CommandPicker({
  commands,
  cities,
  nations,
  generals,
  selectedCityKey,
  defaultCrewType,
  cityResources = false,
  blockedReason,
  targetLabel,
  searchRef,
  onPut,
  cityChoicesFor,
}: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [chosen, setChosen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preparationTarget, setPreparationTarget] = useState<PreparationTarget>('unit');
  const firstArgRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const formId = useId();

  const filtered = useMemo(() => {
    const q = query.trim();
    return commands.filter(
      (command) => (category === 'all' || command.category === category) && (q === '' || command.name.includes(q)),
    );
  }, [commands, query, category]);
  const command = commands.find((c) => c.key === chosen) ?? null;
  const schema = useMemo(
    () => (command ? cityPreparationSchema(command.argsSchema, cityResources, command.key, preparationTarget) : null),
    [command, cityResources, preparationTarget],
  );
  const fields = useMemo(() => (schema ? argFields(schema) : []), [schema]);
  const required = useMemo(() => (schema ? requiredKeys(schema) : []), [schema]);
  const cityDrill = cityResources && command && ['train', 'morale'].includes(command.key);
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
  const choose = (key: string) => {
    setChosen(key);
    const next = commands.find((c) => c.key === key);
    const initial: Record<string, string> = {};
    const mapCity = mapCityFor(next?.key);
    const nextSchema = next ? cityPreparationSchema(next.argsSchema, cityResources, next.key, preparationTarget) : null;
    for (const field of nextSchema ? argFields(nextSchema) : []) {
      if (field.kind === 'city' && mapCity !== null) initial[field.key] = String(mapCity);
      if (field.kind === 'integer' && field.key === 'crewType' && defaultCrewType !== undefined)
        initial[field.key] = String(defaultCrewType);
      if (field.kind === 'boolean') initial[field.key] = 'true';
      if (field.kind === 'enum') initial[field.key] = field.options[0]?.value ?? '';
      if (field.kind === 'color') initial[field.key] = '#8a5a2b';
    }
    setValues(initial);
    return next;
  };

  const put = () => {
    if (!command || !schema || blockedReason || built.missing.length > 0) return;
    onPut({
      commandKey: command.key,
      args: cityDrill && preparationTarget === 'city' ? { ...built.args, target: 'city' } : built.args,
      explicit: true,
    });
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = filtered[0];
    if (!first) return;
    const next = choose(first.key);
    if (next && !(cityResources && ['train', 'morale'].includes(next.key)) && argFields(next.argsSchema).length === 0) {
      if (!blockedReason) onPut({ commandKey: next.key, args: {}, explicit: true });
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

  const groups = CATEGORY_ORDER.map((key) => ({
    key,
    items: filtered.filter((c) => c.category === key),
  })).filter((g) => g.items.length > 0);

  const putReason =
    blockedReason ??
    (!command
      ? '명령을 고르세요.'
      : !schema
        ? '명령 입력 형식을 확인하지 못했습니다.'
        : built.missing.length > 0
          ? `${built.missing.join(', ')} 칸을 채우세요.`
          : null);

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
          {['all', ...CATEGORY_ORDER.filter((key) => commands.some((c) => c.category === key))].map((key) => (
            <button
              key={key}
              type="button"
              className={styles.chip}
              aria-pressed={category === key}
              onClick={() => setCategory(key)}
            >
              {key === 'all' ? '전체' : CATEGORY_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      <div id={listId} className={styles.commandList}>
        {groups.length === 0 ? <p className={styles.muted}>맞는 명령이 없습니다.</p> : null}
        {groups.map((group) => (
          <fieldset key={group.key} className={styles.group}>
            <legend>{CATEGORY_LABELS[group.key] ?? group.key}</legend>
            {group.items.map((item) => (
              <label key={item.key} className={styles.commandOption}>
                <input
                  type="radio"
                  name={`${listId}-command`}
                  value={item.key}
                  checked={chosen === item.key}
                  onChange={() => choose(item.key)}
                />
                {item.name}
              </label>
            ))}
          </fieldset>
        ))}
      </div>

      {command ? (
        <form
          id={formId}
          className={styles.argForm}
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
                  setPreparationTarget(event.target.value === 'city' ? 'city' : 'unit');
                  setValues({});
                }}
              >
                <option value="unit">기존 부곡</option>
                <option value="city">현재 도시 수비병</option>
              </select>
            </label>
          ) : null}
          {costNote ? (
            <p className={styles.muted} role="note">
              {costNote}
            </p>
          ) : null}
          {fields.length === 0 ? <p className={styles.muted}>인자 없이 넣는 명령입니다.</p> : null}
          {fields.map((field, i) => (
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
              note={field.kind === 'city' ? (choices?.note ?? null) : null}
              mapHint={
                field.kind === 'city' &&
                selectedCityKey !== null &&
                mapCityFor(command.key) !== null &&
                values[field.key] !== String(selectedCityKey)
                  ? {
                      name: cities.find((c) => c.key === selectedCityKey)?.name ?? `도시 ${selectedCityKey}`,
                      use: () => setValues((prev) => ({ ...prev, [field.key]: String(selectedCityKey) })),
                    }
                  : null
              }
            />
          ))}
        </form>
      ) : null}

      <div className={styles.putRow}>
        {putReason === null ? (
          <button type="submit" form={formId} className={styles.primary}>
            {targetLabel}에 넣기
          </button>
        ) : (
          <DisabledReason reason={putReason}>{targetLabel}에 넣기</DisabledReason>
        )}
      </div>
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
  } else if (field.kind === 'city' || field.kind === 'nation' || field.kind === 'boolean' || field.kind === 'enum') {
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
        {field.kind === 'city' || field.kind === 'nation' ? <option value="">고르세요</option> : null}
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
        <span>{field.key === 'generalId' && generals ? '대상 장수' : field.label}</span>
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
