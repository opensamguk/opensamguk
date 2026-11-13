import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';
import type { WorldUnits } from '../battleSim/unitChoices';
import { DisabledReason } from '../ui/DisabledReason';
import { argFields, buildArgs, describeArgs, requiredKeys, type ArgField } from './args';
import {
  AmountHelpers,
  CityTargetPicker,
  CommandArgsScreen,
  GeneralTargetPicker,
  NationTargetPicker,
  UnitPicker,
  type ArgContext,
  type ArgNeed,
  type CandidateCheck,
  type TargetGeneral,
} from './CommandArgsScreen';
import type { Turn } from './draft';
import type { Check, SourceQuery } from './source';
import { amountLimit, amountPresets, displayName, OWN_CITY_FIRST, recruitRoom, RESOURCE_ORDER } from './targets';
import { commandAvailability, commandDoc, requirementsText, turnsText } from './commandDoc';
import styles from './TurnEditor.module.css';
import { cityPreparationNote, cityPreparationSchema, hasCityBranch, type PreparationTarget } from './cityResourceArgs';
import { EquipmentTradeFields, equipmentUiSchema } from '../equipment/EquipmentTradeFields';
import type { EquipmentRead } from '../equipment/useEquipment';

type ServerCommand = inferRouterOutputs<AppRouter>['commands']['list'][number];

// 개인·국가 명령 목록에서 명령 카드에 사용하는 응답 필드.
// argsSchema는 화면이 JSON Schema로 읽기만 하므로 unknown으로 둔다.
export type CommandInfo = {
  key: string;
  name: string;
  category: string;
  argsSchema: unknown;
  troopTargets?: readonly { generalId: number; troopName: string }[];
} & Partial<Pick<ServerCommand, 'description' | 'cost' | 'requirements' | 'turns' | 'available' | 'reason'>>;

// 예턴 연결이 넘기는 대상 장수. 국가 칸은 인사부 조회의 소재 도시·유저 여부를 함께 싣는다.
export interface GeneralChoice {
  id: number;
  name: string;
  cityName?: string | undefined;
  isHuman?: boolean | undefined;
}

// 개인 예턴에서 같은 국가 장수를 대상으로 고르는 명령(선양).
const SAME_NATION_TARGET = new Set(['abdicate']);
// 등용. 대상은 서버가 고른 재야 장수 후보(commands.recruitCandidates)에서 고른다.
const RECRUIT_COMMAND = 'invite';
// 대상 국가 후보마다 사전 검사를 묻는 수의 한도. 넘으면 후보 판정 없이 고른 뒤 한 번만 검사한다.
const CANDIDATE_CHECK_LIMIT = 30;

export const CATEGORY_LABELS: Record<string, string> = {
  domestic: '내정',
  military: '군사',
  strategy: '전략',
  personal: '개인',
  nation: '국가',
  rest: '휴식',
  personnel: '인사',
  diplomacy: '외교',
  special: '특수',
  other: '기타',
};
const CATEGORY_ORDER = ['domestic', 'military', 'strategy', 'personal', 'nation'];
const NATION_CATEGORY_ORDER = ['rest', 'personnel', 'diplomacy', 'special', 'strategy', 'other', 'nation'];

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
  generals?: GeneralChoice[] | undefined;
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
  // 인자 입력 화면이 국가·장수 대상을 열 때 알린다. 편집기는 그때부터 순위·외교·국가 장수 조회를 받는다.
  onNeed?: ((kind: ArgNeed) => void) | undefined;
  // 최근 넣은 명령 줄 (원작 최근 실행). 편집기가 만들어 넘기며 명령 찾기 위에 그린다. 없으면 그리지 않는다.
  recent?: ReactNode;
}

// 장비매매 품목 키 → 이름. 장비 정보를 아직 못 받았으면 없다.
export function equipmentName(read: EquipmentRead | undefined): ((itemKey: string) => string | undefined) | undefined {
  if (read?.kind !== 'ready') return undefined;
  const items = read.data.items;
  return (itemKey) => items.find((item) => item.key === itemKey)?.name;
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
  onNeed,
  recent,
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
  // 명령마다 대상 장수 후보. 국가 칸은 넘겨받은 목록, 개인 칸의 선양은 같은 국가 장수(나를 뺀)다.
  // 수치·얼굴·소재 도시는 같은 국가 장수 상세(argContext.members)에서 붙인다.
  const members = argContext.members;
  const myId = argContext.me?.id;
  const recruits = argContext.recruits;
  const generalsFor = (key: string | undefined): TargetGeneral[] | undefined => {
    if (key === RECRUIT_COMMAND && recruits) return [...recruits.list];
    const byId = new Map((members ?? []).map((member) => [member.id, member]));
    if (generals) {
      const troopTargets = commands.find((command) => command.key === key)?.troopTargets;
      const troopNames =
        troopTargets && new Map(troopTargets.map(({ generalId, troopName }) => [generalId, troopName]));
      return generals
        .filter(({ id }) => !troopNames || troopNames.has(id))
        .map((general) => {
          const detail = byId.get(general.id);
          return {
            ...detail,
            ...general,
            cityName: general.cityName ?? detail?.cityName,
            troopName: troopNames?.get(general.id),
          };
        });
    }
    if (key && SAME_NATION_TARGET.has(key) && members) return members.filter((member) => member.id !== myId);
    return undefined;
  };
  // 대상 장수를 이름으로 고르면 카드 설명·입력 칸·누락 안내가 같은 이름을 쓴다.
  const fieldsFor = (target: unknown, key?: string): ArgField[] =>
    target
      ? argFields(target, units.all, units.armTypes).map((field) =>
          field.key === 'generalId' && generalsFor(key) ? { ...field, label: '대상 장수' } : field,
        )
      : [];

  const categories = useMemo(
    () =>
      [
        ...new Set([
          ...(argContext.walletKind === 'nation' ? NATION_CATEGORY_ORDER : CATEGORY_ORDER),
          ...commands.map((command) => command.category),
        ]),
      ].filter((key) => commands.some((command) => command.category === key)),
    [commands, argContext.walletKind],
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
  const fields = fieldsFor(schema, command?.key);
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
    for (const field of fieldsFor(nextSchema, key)) {
      if (field.kind === 'city' && mapCity !== null) initial[field.key] = String(mapCity);
      // 지금 거느린 병종을 먼저 고른다(병력이 있으면 소집해제 전엔 바꿀 수 없다). 없으면 월드 기본 병종, 첫 장수 병종 순이다.
      if (field.kind === 'unit') {
        const own = defaultCrewType == null ? undefined : String(defaultCrewType);
        const fallback = units.defaultId === undefined ? undefined : String(units.defaultId);
        initial[field.key] =
          [own, fallback].find((v) => field.options.some((o) => o.value === v)) ?? field.options[0]?.value ?? '';
      }
      if (field.kind === 'boolean') initial[field.key] = 'true';
      if (field.kind === 'enum' && !field.philosophyEffects) initial[field.key] = field.options[0]?.value ?? '';
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
    if (
      nextSchema &&
      !(cityResources && hasCityBranch(first.argsSchema)) &&
      fieldsFor(nextSchema, first.key).length === 0
    ) {
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
  const screenGenerals = generalsFor(command?.key);
  const summary = command
    ? [
        command.name,
        describeArgs(built.args, {
          city: (key) => cities.find((c) => c.key === key)?.name,
          nation: (id) => nations.find((n) => n.id === id)?.name,
          general: screenGenerals ? (id) => screenGenerals.find((g) => g.id === id)?.name : undefined,
          unit: (id) => units.name(id),
          armType: (id) => units.armTypes?.[id],
          equipment: equipmentName(equipment),
        }),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  // 국가·장수 대상 화면을 열면 편집기에 알려 순위·외교·국가 장수 조회를 받게 한다.
  const wantsNations = needsScreen && fields.some((field) => field.kind === 'nation');
  // 등용 대상은 재야 장수라 국가 장수 상세 대신 등용 후보를 받는다.
  const recruiting = needsScreen && command?.key === RECRUIT_COMMAND;
  const wantsGenerals = needsScreen && !recruiting && fields.some((field) => field.key === 'generalId');
  useEffect(() => {
    if (wantsNations) onNeed?.('nations');
  }, [wantsNations, onNeed]);
  useEffect(() => {
    if (wantsGenerals) onNeed?.('generals');
  }, [wantsGenerals, onNeed]);
  useEffect(() => {
    if (recruiting) onNeed?.('recruits');
  }, [recruiting, onNeed]);

  // 대상 국가 후보마다 넣을 명령. 국가 하나만 고르는 명령(임관·선전포고·불가침 등)만 묻는다.
  // 수량처럼 치는 칸이 있으면 칠 때마다 후보 수만큼 다시 묻게 되므로 묻지 않는다. 후보가 많아도 묻지 않는다.
  const nationField = fields.length === 1 && fields[0]!.kind === 'nation' ? fields[0] : undefined;
  const candidateTurns =
    command && nationField && precheck && nations.length <= CANDIDATE_CHECK_LIMIT
      ? nations.flatMap((nation) => {
          const trial = buildArgs(fields, required, { ...values, [nationField.key]: String(nation.id) });
          const turn: Turn = { commandKey: command.key, args: trial.args, explicit: true };
          return trial.missing.length === 0 ? [{ id: nation.id, turn }] : [];
        })
      : [];

  // 수량 칸의 빠른 입력. 모병·징병은 통솔 한도까지, 그 밖은 자주 쓰는 값과 가진 만큼이다.
  const amountButtons = (field: ArgField): Array<{ text: string; value: number }> => {
    if (field.kind !== 'integer' || field.key !== 'amount' || !command) return [];
    const inRange = (value: number) => value >= field.min && value <= field.max;
    const me = argContext.me;
    if ((command.key === 'recruit' || command.key === 'conscript') && me) {
      const { half, room } = recruitRoom(me.leadership, me.crew);
      return [
        { text: `절반 ${half.toLocaleString('ko-KR')}명`, value: half },
        { text: `채우기 ${room.toLocaleString('ko-KR')}명`, value: room },
      ].filter((button) => inRange(button.value));
    }
    const presets = amountPresets(field.min, field.max).map((value) => ({
      text: value.toLocaleString('ko-KR'),
      value,
    }));
    const all = amountLimit(command.key, values, {
      wallet: argContext.wallet,
      treasury: argContext.treasury,
      target: screenGenerals?.find((general) => String(general.id) === values.generalId),
    });
    return all !== null && inRange(all)
      ? [...presets, { text: `전부 ${all.toLocaleString('ko-KR')}`, value: all }]
      : presets;
  };
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
      {recent}
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
                const cardFields = fieldsFor(cardSchema, item.key);
                const cardRequired = requiredKeys(cardSchema);
                const cardId = `${listId}-${item.key}`;
                const cost = commandDoc(item).cost;
                const availability = commandAvailability(item);
                const describedBy = [
                  cost ? `${cardId}-cost` : null,
                  availability.reason ? `${cardId}-reason` : null,
                  `${cardId}-hint`,
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <label
                    key={item.key}
                    className={styles.commandOption}
                    data-checked={chosen === item.key}
                    data-available={availability.dimmed ? 'false' : undefined}
                  >
                    <input
                      type="radio"
                      name={`${listId}-command`}
                      value={item.key}
                      checked={chosen === item.key}
                      aria-labelledby={`${cardId}-name`}
                      aria-describedby={describedBy}
                      onChange={() => choose(item.key)}
                    />
                    <span className={styles.commandBody}>
                      <strong id={`${cardId}-name`}>{item.name}</strong>
                      {/* 원작 카드처럼 이름 아래 둘째 줄에 비용을 적는다 (INT-26 도움말이 있을 때만). */}
                      {cost ? (
                        <span id={`${cardId}-cost`} className={styles.commandCost}>
                          {cost}
                        </span>
                      ) : null}
                      {/* 지금 실행할 수 없는 명령은 흐리게 두고 사유를 적는다. 그래도 고르고 넣을 수 있다. */}
                      {availability.reason ? (
                        <span id={`${cardId}-reason`} className={styles.commandReason} data-testid="command-reason">
                          {availability.reason}
                        </span>
                      ) : null}
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
              <CommandDocNotes command={command} />
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
                <EquipmentTradeFields
                  read={equipment}
                  values={values}
                  onChange={setValues}
                  firstArgRef={firstArgRef}
                  security={argContext.security}
                />
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
                        !(field.key === 'generalId' && screenGenerals),
                    )
                    .map((field, i) => {
                      const set = (value: string) => setValues((prev) => ({ ...prev, [field.key]: value }));
                      const buttons = amountButtons(field);
                      return (
                        <ArgInput
                          key={field.key}
                          field={field}
                          value={values[field.key] ?? ''}
                          cities={cityOptions}
                          nations={nations}
                          generals={screenGenerals}
                          inputRef={i === 0 ? firstArgRef : undefined}
                          onKeyDown={onArgKey}
                          onChange={set}
                          note={field.kind === 'unit' && field.options.length === 0 ? unitNote : null}
                          mapHint={null}
                          after={
                            field.kind === 'integer' && field.key === 'amount' ? (
                              <AmountHelpers
                                label={field.label}
                                buttons={buttons}
                                onPick={(value) => set(String(value))}
                                preview={ready && precheck ? <CostPreview query={precheck(ready)} /> : null}
                              />
                            ) : null
                          }
                        />
                      );
                    })}
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
                        ownFirst={OWN_CITY_FIRST.has(command.key)}
                      />
                    );
                  if (field.kind === 'nation') {
                    const picker = (checks?: ReadonlyMap<number, CandidateCheck>) => (
                      <NationTargetPicker
                        key={field.key}
                        context={argContext}
                        label={field.label}
                        value={value}
                        options={nations}
                        onChange={set}
                        checks={checks}
                        showIntroductions={command.key === 'join'}
                      />
                    );
                    return precheck && candidateTurns.length > 0 ? (
                      <CandidateChecks key={field.key} candidates={candidateTurns} precheck={precheck}>
                        {picker}
                      </CandidateChecks>
                    ) : (
                      picker()
                    );
                  }
                  if (field.key === 'generalId' && screenGenerals) {
                    const direction = RESOURCE_ORDER[command.key];
                    const resource = values.resource === 'rice' ? 'rice' : 'gold';
                    return (
                      <GeneralTargetPicker
                        key={field.key}
                        label={field.label}
                        value={value}
                        options={screenGenerals}
                        onChange={set}
                        order={direction ? { resource, direction } : null}
                        {...(command.key === RECRUIT_COMMAND && recruits
                          ? { note: recruits.note, empty: '등용할 수 있는 재야 장수가 없습니다' }
                          : {})}
                        {...(command.troopTargets ? { empty: '탈퇴를 지시할 부대원이 없습니다' } : {})}
                      />
                    );
                  }
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
  after = null,
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
  // 칸 바로 아래에 붙이는 도움(수량 빠른 입력 등).
  after?: ReactNode;
}) {
  const ref = inputRef as RefObject<HTMLInputElement & HTMLSelectElement> | undefined;
  let control;
  if (field.key === 'generalId' && generals) {
    control = (
      <select ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}>
        <option value="">고르세요</option>
        {generals.map((g) => (
          <option key={g.id} value={String(g.id)}>
            {displayName(g.name)}
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
        (field.kind === 'enum' && field.philosophyEffects) ||
        (field.kind === 'unit' && !field.options.some((option) => option.value === value)) ? (
          <option value="">{field.kind === 'enum' && field.philosophyEffects ? '중립' : '고르세요'}</option>
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
      {field.kind === 'enum' && field.philosophyEffects ? (
        <details>
          <summary>국가 성향 장단점</summary>
          <ul>
            {field.options.map((option) => {
              const effects = field.philosophyEffects?.[option.value];
              if (!effects) return null;
              const text = `${option.label} · 장점 ${effects.benefits.join(', ') || '없음'} · 단점 ${effects.drawbacks.join(', ') || '없음'}`;
              return <li key={option.value}>{option.value === value ? <strong>{text}</strong> : text}</li>;
            })}
          </ul>
        </details>
      ) : null}
      {after}
    </div>
  );
}

// 명령 도움말 (INT-26). 서버가 실어 준 설명·비용·요구 조건·소요 턴만 안내 줄에 적는다.
function CommandDocNotes({ command }: { command: CommandInfo }) {
  const { description, cost, requirements, turns } = commandDoc(command);
  const requires = requirementsText(requirements);
  const duration = turnsText(turns);
  return (
    <>
      {description ? <span data-testid="command-description">{description}</span> : null}
      {cost ? <span data-testid="command-cost">비용: {cost}</span> : null}
      {requires ? <span data-testid="command-requirements">{requires}</span> : null}
      {duration ? <span data-testid="command-turns">{duration}</span> : null}
    </>
  );
}

// 수량 칸 옆의 예상 금. 서버 사전 검사 미리보기(능력치 다섯 판)의 값을 그대로 적는다. 없으면 그리지 않는다.
function CostPreview({ query }: { query: SourceQuery<Check> }) {
  const check = useQuery({ queryKey: query.queryKey, queryFn: query.queryFn, select: query.select, retry: false });
  const preview = check.data?.preview;
  if (!preview) return null;
  return (
    <p className={styles.costPreview} data-testid="cost-preview">
      예상 금 <span className="num">{preview.goldCost.toLocaleString('ko-KR')}</span>
    </p>
  );
}

// 대상 국가 후보마다 사전 검사를 묻는다. 30칸 표와 같은 조회 키라 캐시를 같이 쓴다.
function CandidateChecks({
  candidates,
  precheck,
  children,
}: {
  candidates: ReadonlyArray<{ id: number; turn: Turn }>;
  precheck: (turn: Turn) => SourceQuery<Check>;
  children: (checks: ReadonlyMap<number, CandidateCheck>) => ReactNode;
}) {
  const results = useQueries({
    queries: candidates.map(({ turn }) => {
      const query = precheck(turn);
      return {
        queryKey: query.queryKey,
        queryFn: query.queryFn,
        select: query.select,
        staleTime: 15_000,
        retry: false,
      };
    }),
  });
  const checks = new Map<number, CandidateCheck>();
  candidates.forEach(({ id }, i) => {
    const data = results[i]?.data;
    if (data) checks.set(id, data.ok ? { ok: true } : { ok: false, message: data.message });
  });
  return <>{children(checks)}</>;
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
