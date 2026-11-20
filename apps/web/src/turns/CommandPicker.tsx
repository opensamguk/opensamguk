import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
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
  type ArgStep,
} from './CommandArgsScreen';
import type { Turn } from './draft';
import type { Check, SourceQuery } from './source';
import { amountLimit, amountPresets, displayName, OWN_CITY_FIRST, recruitRoom, RESOURCE_ORDER } from './targets';
import { commandAvailability, commandDoc, requirementsText, turnsText } from './commandDoc';
import { bandGroups, letteringSource, plaqueSource, ROLE_LABEL, type BandRole } from './commandBand';
import { PLAQUE_FACES } from './plaqueFaces';
import { hasPublicImage, publicImageUrl } from '@opensamguk/shared/public-images';
import styles from './TurnEditor.module.css';
import {
  cityBranchUsesTarget,
  cityPreparationNote,
  cityPreparationSchema,
  hasCityBranch,
  type PreparationTarget,
} from './cityResourceArgs';
import { EquipmentTradeFields, equipmentUiSchema } from '../equipment/EquipmentTradeFields';
import type { EquipmentRead } from '../equipment/useEquipment';

type ServerCommand = inferRouterOutputs<AppRouter>['commands']['list'][number];

// 서버 명령 목록(commands.list)의 한 줄. 국가 명령(nationCommands.list)은 도움말 없이 가능 여부만 실어 도움말 칸은 비어 있을 수 있다.
// argsSchema는 화면이 JSON Schema로 읽기만 하므로 unknown으로 둔다.
export type CommandInfo = {
  key: string;
  name: string;
  category: string;
  argsSchema: unknown;
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
};

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
  equipment?: EquipmentRead | undefined;
  // 넣을 수 없을 때의 이유. null이면 넣을 수 있다.
  blockedReason: string | null;
  targetLabel: string;
  // 명령 고르기의 첫 초점 자리(띠의 첫 패). 예턴 칸에서 Enter를 누르면 여기로 온다.
  focusRef?: RefObject<HTMLButtonElement | null> | undefined;
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
  // 최근 넣은 명령 줄 (원작 최근 실행). 편집기가 만들어 넘기며 명령 띠 위에 그린다. 없으면 그리지 않는다.
  recent?: ReactNode;
  // 직위별 명령 띠 (D-099). 없으면 군주 띠처럼 모든 묶음을 보인다.
  role?: BandRole | undefined;
  // 직위상 직접 넣을 수 없는 명령이면 넣기 대신 권한자에게 제안한다 (D-100). to는 받는 사람 설명이다.
  propose?: { to: string; onPropose: (turn: Turn, note: string) => void } | undefined;
}

// 장비매매 품목 키 → 이름. 장비 정보를 아직 못 받았으면 없다.
export function equipmentName(read: EquipmentRead | undefined): ((itemKey: string) => string | undefined) | undefined {
  if (read?.kind !== 'ready') return undefined;
  const items = read.data.items;
  return (itemKey) => items.find((item) => item.key === itemKey)?.name;
}

// 서버가 준 명령을 직위별 명령 띠로 고른다. 묶음 패를 누르면 위로 세부 명령이 올라오고, 세부 명령을 누르면
// 인자가 없으면 바로 넣고, 있으면 인자 창을 연다(원작처럼 띠 아래 목록, 검색 칸, 넣기 단추는 없다).
/** 글자 그림이 승인 목록에 있으면 그림으로, 없으면 글자로 쓴다. 그림일 때도 화면 읽기에는 글자로 읽힌다. */
function Lettering({ source, text, className }: { source: string; text: string; className?: string | undefined }) {
  if (!hasPublicImage(source)) return <>{text}</>;
  return (
    <>
      <img className={className ?? styles.lettering} src={publicImageUrl(source)} alt="" />
      <span className={styles.srOnly}>{text}</span>
    </>
  );
}

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
  equipment,
  blockedReason,
  targetLabel,
  focusRef,
  onPut,
  onSave,
  cityChoicesFor,
  precheck,
  argContext = { here: null, ownNationId: null },
  onNeed,
  recent,
  role = 'ruler',
  propose,
}: Props) {
  const [category, setCategory] = useState<string>('all');
  // 이름으로 명령 찾기. 명령 띠 개편(INT-29) 뒤에도 둔다: 명령이 많은 직위에서 띠를 다 펼치지 않고 바로 고른다.
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [preparationTarget, setPreparationTarget] = useState<PreparationTarget>('unit');
  // 단계식 인자 창의 지금 단계 (D-100).
  const [argStep, setArgStep] = useState(0);
  const [proposalNote, setProposalNote] = useState('');
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
    item.key === 'equipment_trade' ? equipmentUiSchema : cityPreparationSchema(item.argsSchema, target);
  // 명령마다 대상 장수 후보. 국가 칸은 넘겨받은 목록, 개인 칸의 선양은 같은 국가 장수(나를 뺀)다.
  // 수치·얼굴·소재 도시는 같은 국가 장수 상세(argContext.members)에서 붙인다.
  const members = argContext.members;
  const myId = argContext.me?.id;
  const recruits = argContext.recruits;
  const generalsFor = (key: string | undefined): TargetGeneral[] | undefined => {
    if (key === RECRUIT_COMMAND && recruits) return [...recruits.list];
    const byId = new Map((members ?? []).map((member) => [member.id, member]));
    if (generals)
      return generals.map((general) => {
        const detail = byId.get(general.id);
        return { ...detail, ...general, cityName: general.cityName ?? detail?.cityName };
      });
    if (key && SAME_NATION_TARGET.has(key) && members) return members.filter((member) => member.id !== myId);
    return undefined;
  };
  // 대상 장수를 이름으로 고르면 카드 설명·입력 칸·누락 안내가 같은 이름을 쓴다.
  const fieldsFor = (target: unknown, key?: string): ArgField[] =>
    target
      ? argFields(target, units.all, argContext.campaignUnits).map((field) =>
          field.key === 'generalId' && generalsFor(key) ? { ...field, label: '대상 장수' } : field,
        )
      : [];

  // 직위별 명령 띠의 묶음 (D-099). 모르는 서버 분류는 그 이름 그대로 따로 묶는다.
  const band = useMemo(() => bandGroups(commands, role, (key) => CATEGORY_LABELS[key] ?? key), [commands, role]);
  const activeCategory = band.some((group) => group.key === category) ? category : 'all';
  const activeGroup = band.find((group) => group.key === activeCategory) ?? null;
  const found = useMemo(() => {
    const q = query.trim();
    if (q === '') return [];
    // 화면 띠 순서대로 놓고, 띠에 없는 명령(직위 띠 밖의 명령)은 그 뒤에 서버 순서로 붙인다. 찾기는 받은 명령 전체에서 한다.
    // 검색 Enter는 이 순서의 첫 명령을 고른다.
    const inBand = band.flatMap((group) => group.items);
    const order = [...inBand, ...commands.filter((command) => !inBand.includes(command))];
    return order.filter((item, index) => item.name.includes(q) && order.indexOf(item) === index);
  }, [band, commands, query]);
  // 명령 띠 바탕: 신분별 담장 조각(왼끝, 이음, 가운데 문, 바닥)과 직위 인수 표지 (Codex walls2/, badges4/).
  const bandArt = useMemo(() => {
    const url = (source: string) => (hasPublicImage(source) ? `url(${publicImageUrl(source)})` : null);
    const piece = (name: string) => url(`apps/web/src/art/band/walls/${role}-${name}.webp`);
    const [cap, center, tile, floor] = [piece('cap'), piece('center'), piece('tile'), piece('floor')];
    const walls = Boolean(cap && center && tile && floor);
    const badgeSource = `apps/web/src/art/band/badges/${role}.webp`;
    return {
      walls,
      vars: walls ? { '--wall-cap': cap, '--wall-center': center, '--wall-tile': tile, '--wall-floor': floor } : {},
      badge: hasPublicImage(badgeSource) ? publicImageUrl(badgeSource) : null,
    };
  }, [role]);
  // 세부 명령 목록의 그림: 신분별 받침 판(위끝, 홈, 아래끝)과 면별 목록 패 4상태 (Codex sublist/).
  // 군주는 받침 판 없이 깃발만 선다. 그림이 승인 목록에 없으면 색 판으로 둔다.
  const subArt = useMemo(() => {
    const vars: Record<string, string> = {};
    const url = (name: string) => {
      const source = `apps/web/src/art/band/sublist/${name}.webp`;
      return hasPublicImage(source) ? `url(${publicImageUrl(source)})` : null;
    };
    const side = activeGroup?.side;
    const face = role === 'free' && side === 'appoint' ? 'realm' : side;
    const item = face === 'realm' || face === 'appoint' || face === 'self' ? url(`item-${role}-${face}`) : null;
    if (item) vars['--item'] = item;
    const top = role === 'ruler' ? null : url(`frame-${role}-top`);
    const slot = role === 'ruler' ? null : url(`frame-${role}-slot`);
    const bottom = role === 'ruler' ? null : url(`frame-${role}-bottom`);
    // 군주 깃발 줄: 이어 붙이는 깃대 토막과 맨 위 깃봉 (Codex sublist/finial-ruler, pole-ruler).
    const pole = role === 'ruler' ? url('pole-ruler') : null;
    const finial = role === 'ruler' ? url('finial-ruler') : null;
    if (pole && finial) Object.assign(vars, { '--pole': pole, '--finial': finial });
    const framed = Boolean(top && slot && bottom);
    if (framed) Object.assign(vars, { '--frame-top': top, '--frame-slot': slot, '--frame-bottom': bottom });
    return { vars, framed, item: Boolean(item) };
  }, [activeGroup?.side, role]);
  // 세부 명령 목록을 고른 패 바로 위에 붙이려고 패의 가로 위치를 잰다.
  const bandWrapRef = useRef<HTMLDivElement>(null);
  const plaqueRefs = useRef(new Map<string, HTMLButtonElement>());
  const [subAnchor, setSubAnchor] = useState({ left: 0, bottom: 0 });
  useLayoutEffect(() => {
    const plaque = activeGroup ? plaqueRefs.current.get(activeGroup.key) : undefined;
    const wrap = bandWrapRef.current;
    if (!plaque || !wrap) return;
    const at = plaque.getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    // 군주 깃발 줄은 고른 병사의 깃대(고름 칸의 깃대 꼭대기, plaqueFaces.ts pole) 위에 이어 세운다.
    // 깃발 그림(256 너비 칸을 240px로 줄임) 안 깃대 가운데는 왼쪽에서 7 × 0.9375 = 6.6px다(sublist/finial-ruler.json).
    const face = PLAQUE_FACES[plaqueSource(role, activeGroup!.side)?.replace(/^.*\/|\.webp$/g, '') ?? ''];
    const poleShift = role === 'ruler' && face?.pole !== undefined ? face.pole - 6.6 : 0;
    setSubAnchor({ left: at.left - box.left + poleShift, bottom: box.bottom - at.top });
  }, [activeGroup, role]);

  const command = commands.find((c) => c.key === chosen) ?? null;
  const schema = command ? schemaFor(command, preparationTarget) : null;
  const fields = fieldsFor(schema, command?.key);
  const required = schema ? requiredKeys(schema) : [];
  // 도시 자원 판에서 서버 schema에 도시 수비병 갈래가 있는 명령(INT-18의 훈련·사기)만 갈래를 고른다.
  // 고른 뒤 서버 목록에서 갈래가 사라져도 부곡으로 되돌릴 수 있도록 고른 상태면 선택 칸을 남긴다.
  const cityDrill = command && (hasCityBranch(command.argsSchema) || preparationTarget === 'city');
  const costNote = command ? cityPreparationNote(command.key, preparationTarget) : null;
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
    setArgStep(0);
    setProposalNote('');
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
      // 부곡 칸은 새 부곡(모병, 징병)이나 첫 내 부곡을 먼저 고른다.
      if (field.kind === 'campaignUnit') initial[field.key] = field.options[0]?.value ?? '';
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
          args:
            cityDrill && preparationTarget === 'city' && cityBranchUsesTarget(command.argsSchema)
              ? { ...built.args, target: 'city' }
              : built.args,
          explicit: true,
        }
      : null;
  const put = (save = true) => {
    if (!ready || blockedReason) return;
    (save && onSave ? onSave : onPut)(ready);
    // 인자 입력 화면은 넣은 뒤 닫는다. 인자 없는 명령은 카드 고른 상태를 그대로 둔다.
    if (needsScreen) close();
  };

  // 세부 명령을 누르면 원작처럼 바로 실행한다. 인자 없는 명령은 고른 칸에 곧장 넣고(저장 경로가 있으면 저장),
  // 인자가 있으면 인자 창을 연다. 권한 밖이라 제안해야 하면 제안 칸을 연다. 넣을 수 없으면 이유를 적는다.
  const pick = (item: CommandInfo) => {
    const nextSchema = choose(item.key);
    if (propose) return;
    const direct =
      nextSchema && !hasCityBranch(item.argsSchema) && item.key !== 'equipment_trade'
        ? fieldsFor(nextSchema, item.key).length === 0
        : false;
    if (direct) {
      if (!blockedReason) (onSave ?? onPut)({ commandKey: item.key, args: {}, explicit: true });
    } else {
      // 인자 칸이 그려진 뒤 옮긴다.
      requestAnimationFrame(() => firstArgRef.current?.focus());
    }
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = found[0];
    if (first) pick(first);
  };

  const onArgKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' && !(event.target instanceof HTMLSelectElement)) {
      event.preventDefault();
      submitArgs();
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
    requestAnimationFrame(() => focusRef?.current?.focus());
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
          equipment: equipmentName(equipment),
        }),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  // 단계식 인자 창의 단계 (D-100, 원작처럼 대상 → 내용 → 확인 차례로 묻는다).
  // 대상 칸(도시·국가·장수·병종)은 하나씩, 나머지 칸은 '내용' 한 단계, 마지막은 확인이다.
  const isPickerField = (field: ArgField) =>
    field.kind === 'city' ||
    field.kind === 'nation' ||
    field.kind === 'unit' ||
    (field.key === 'generalId' && Boolean(screenGenerals));
  const stepValue = (field: ArgField): string | undefined => {
    const raw = values[field.key];
    if (!raw) return undefined;
    if (field.kind === 'city') return cityOptions.find((option) => String(option.key) === raw)?.name;
    if (field.kind === 'nation') return nations.find((nation) => String(nation.id) === raw)?.name;
    if (field.kind === 'unit') return units.name(Number(raw));
    if (field.key === 'generalId') return screenGenerals?.find((general) => String(general.id) === raw)?.name;
    return raw;
  };
  const hasContentStep =
    command?.key === 'equipment_trade' || Boolean(cityDrill) || fields.some((field) => !isPickerField(field));
  const argSteps: ArgStep[] = needsScreen
    ? [
        ...(command?.key === 'equipment_trade'
          ? []
          : fields
              .filter(isPickerField)
              .map((field) => ({ key: `f:${field.key}`, label: field.label, value: stepValue(field) }))),
        ...(hasContentStep ? [{ key: 'content', label: command?.key === 'equipment_trade' ? '품목' : '내용' }] : []),
        { key: 'confirm', label: propose ? '제안' : '확인' },
      ]
    : [];
  const stepIndex = Math.min(argStep, Math.max(0, argSteps.length - 1));
  // 인자 칸의 Enter와 폼 제출. 앞 단계에서는 다음 단계로만 가고, 확인 단계에서만 넣는다(D-100 확인 단계).
  // 제안해야 하는 명령은 Enter로 보내지 않는다. 사유를 적고 제안하기 단추를 눌러야 한다.
  const submitArgs = () => {
    if (needsScreen && stepIndex < argSteps.length - 1) setArgStep(stepIndex + 1);
    else if (!propose) put();
  };
  const stepProps = (key: string) => ({
    'data-arg-step': key,
    'data-arg-step-current': argSteps[stepIndex]?.key === key ? 'true' : undefined,
  });

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
  // 단계마다 그릴 대상 칸 (도시·국가·장수·병종). 대상 칸이 아니면 null이다.
  const pickerFor = (field: ArgField): ReactNode => {
    if (!command) return null;
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
          pathMode={command.key === 'move' ? 'move' : command.key === 'attack' ? 'attack' : null}
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
              ? `${recruitment.city}의 현재 모집 조건입니다.`
              : field.options.length === 0
                ? unitNote
                : null
          }
          onChange={set}
        />
      );
    return null;
  };

  // 제안(상신) 단계: 넣기 대신 사유를 적어 권한자에게 올린다 (D-100).
  const proposeButton = propose ? (
    <div className={styles.proposeForm}>
      <label className={styles.argLabel}>
        <span>{propose.to}에게 올릴 사유 (선택, 200자)</span>
        <textarea
          value={proposalNote}
          maxLength={200}
          rows={2}
          onChange={(event) => setProposalNote(event.target.value)}
        />
      </label>
      {putReason === null && ready ? (
        <button
          type="button"
          className={styles.primary}
          onClick={() => {
            propose.onPropose(ready, proposalNote.trim());
            close();
          }}
        >
          {propose.to}에게 제안하기
        </button>
      ) : (
        <DisabledReason reason={putReason ?? '칸을 채우세요.'}>{propose.to}에게 제안하기</DisabledReason>
      )}
    </div>
  ) : null;

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
          title={onSave ? '초안에만 넣습니다. 저장은 나중에 한꺼번에 합니다.' : undefined}
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
      <label className={styles.search}>
        <span>명령 찾기</span>
        <input
          type="search"
          value={query}
          placeholder="이름으로 찾기, Enter로 고르기"
          aria-controls={`${listId}-found`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
        />
      </label>
      {query.trim() !== '' ? (
        <div id={`${listId}-found`} className={styles.found} role="radiogroup" aria-label="찾은 명령">
          {found.length === 0 ? (
            <p className={styles.foundEmpty}>이름에 “{query.trim()}”이 든 명령이 없습니다.</p>
          ) : (
            found.map((item) => {
              const availability = commandAvailability(item);
              const cost = commandDoc(item).cost;
              const foundId = `${listId}-found-${item.key}`;
              return (
                <label
                  key={item.key}
                  className={styles.foundOption}
                  data-checked={chosen === item.key ? 'true' : undefined}
                  data-available={availability.dimmed ? 'false' : undefined}
                >
                  <input
                    type="radio"
                    name={`${listId}-found`}
                    value={item.key}
                    checked={chosen === item.key}
                    aria-labelledby={`${foundId}-name`}
                    aria-describedby={availability.reason ? `${foundId}-reason` : undefined}
                    onChange={() => choose(item.key)}
                  />
                  <span id={`${foundId}-name`}>{item.name}</span>
                  {cost ? <span className={styles.foundCost}>{cost}</span> : null}
                  {availability.reason ? (
                    <span id={`${foundId}-reason`} className={styles.foundReason} data-testid="command-reason">
                      {availability.reason}
                    </span>
                  ) : null}
                </label>
              );
            })
          )}
        </div>
      ) : null}
      <div className={styles.pickerHead}>
        {/* 직위별 명령 띠: 담장 바탕은 직위마다, 패 색은 세력 명령·임면·개인 명령마다 다르다 (D-099). */}
        <div className={styles.bandWrap} ref={bandWrapRef}>
          <div
            className={styles.categories}
            role="group"
            aria-label="명령 분류"
            data-role={role}
            data-walls={bandArt.walls ? 'true' : undefined}
            style={bandArt.vars as CSSProperties}
          >
            <span className={styles.bandRole}>
              {bandArt.badge ? <img className={styles.bandBadge} src={bandArt.badge} alt="" /> : null}
              <Lettering
                source={letteringSource('role', role)}
                text={ROLE_LABEL[role]}
                className={styles.roleLettering}
              />
            </span>
            {band.map((group) => {
              const plaque = plaqueSource(role, group.side);
              // 패가 들리면 글자도 앞면을 따라 올라간다 (plaques2/faces.json).
              const face = plaque ? PLAQUE_FACES[plaque.replace(/^.*\/|\.webp$/g, '')] : undefined;
              const faces = face?.frames;
              const faceVars = face
                ? Object.fromEntries([
                    ['--lh', `${face.size}px`],
                    ...face.frames.flatMap(([x, y, top, bottom], frame) => [
                      [`--f${frame}x`, `${x}%`],
                      [`--f${frame}y`, `${y}%`],
                      [`--f${frame}t`, `${top}px`],
                      [`--f${frame}b`, `${bottom}px`],
                    ]),
                  ])
                : {};
              const groupLettering = letteringSource('group', group.key);
              return (
                <button
                  key={group.key}
                  type="button"
                  className={styles.chip}
                  data-side={group.side}
                  data-plaque={plaque ? 'true' : undefined}
                  data-frames={faces ? '5' : undefined}
                  style={
                    plaque
                      ? ({ '--plaque': `url(${publicImageUrl(plaque)})`, ...faceVars } as CSSProperties)
                      : undefined
                  }
                  aria-pressed={activeCategory === group.key}
                  aria-expanded={activeCategory === group.key}
                  ref={(node) => {
                    if (node) plaqueRefs.current.set(group.key, node);
                    else plaqueRefs.current.delete(group.key);
                    if (focusRef && group === band[0])
                      (focusRef as MutableRefObject<HTMLButtonElement | null>).current = node;
                  }}
                  onClick={() => setCategory(activeCategory === group.key ? 'all' : group.key)}
                >
                  {face ? (
                    <span className={styles.plaqueText} data-flow={face.flow}>
                      {face.flow === 'h' && hasPublicImage(groupLettering) ? (
                        // 넓고 낮은 앞면: 세로 글자 그림의 두 글자를 잘라 가로로 나란히 놓는다.
                        <>
                          {[0, 1].map((index) => (
                            <span
                              key={index}
                              className={styles.plaqueChar}
                              data-char={index}
                              style={{ backgroundImage: `url(${publicImageUrl(groupLettering)})` }}
                            />
                          ))}
                          <span className={styles.srOnly}>{group.label}</span>
                        </>
                      ) : (
                        <Lettering source={groupLettering} text={group.label} />
                      )}
                    </span>
                  ) : (
                    group.label
                  )}
                </button>
              );
            })}
          </div>
          {/* 세부 명령 목록: 묶음 패를 고르면 그 패 아래로 세부 명령이 세로로 펼쳐진다 (사용자 2026-11-15
            "명령에 세부 명령도 띠로 띄우는거", "명령패 다음엔 명령 리스트가 있어야 하는데?"). 신분마다 목록 모양이 다르다. */}
          {activeGroup ? (
            <div
              key={activeGroup.key}
              className={styles.subBand}
              role="group"
              aria-label={`${activeGroup.label} 세부 명령`}
              data-role={role}
              data-side={activeGroup.side}
              data-framed={subArt.framed ? 'true' : undefined}
              data-item-art={subArt.item ? 'true' : undefined}
              style={
                {
                  '--anchor': `${subAnchor.left}px`,
                  '--anchor-bottom': `${subAnchor.bottom}px`,
                  '--n': activeGroup.items.length,
                  ...subArt.vars,
                } as CSSProperties
              }
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setCategory('all');
                plaqueRefs.current.get(activeGroup.key)?.focus();
              }}
            >
              {activeGroup.items.map((item, index) => {
                const lettering = letteringSource('cmd', item.key);
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
                  // 깃발, 이름표가 곧 명령 단추다(원작처럼 누르면 바로 넣고, 인자가 있으면 인자 창을 연다).
                  <button
                    key={item.key}
                    type="button"
                    className={styles.subCommand}
                    style={{ '--i': index } as CSSProperties}
                    aria-pressed={chosen === item.key}
                    aria-labelledby={`${cardId}-name`}
                    aria-describedby={describedBy}
                    data-checked={chosen === item.key ? 'true' : undefined}
                    data-available={availability.dimmed ? 'false' : undefined}
                    title={availability.reason ?? undefined}
                    onClick={() => pick(item)}
                  >
                    <span id={`${cardId}-name`} className={styles.subName}>
                      {hasPublicImage(lettering) ? (
                        <>
                          <img className={styles.subLettering} src={publicImageUrl(lettering)} alt="" />
                          <span className={styles.srOnly}>{item.name}</span>
                        </>
                      ) : (
                        item.name
                      )}
                    </span>
                    {cost ? (
                      <span id={`${cardId}-cost`} className={styles.srOnly}>
                        {cost}
                      </span>
                    ) : null}
                    {availability.reason ? (
                      <span id={`${cardId}-reason`} className={styles.srOnly} data-testid="command-reason">
                        {availability.reason}
                      </span>
                    ) : null}
                    <span id={`${cardId}-hint`} className={styles.srOnly}>
                      {CATEGORY_LABELS[item.category] ?? item.category}
                      {' · '}
                      {!cardSchema
                        ? '입력 형식 확인 필요'
                        : cardFields
                            .map((field) => `${field.label}${cardRequired.includes(field.key) ? ' (필수)' : ''}`)
                            .join(' · ') || '고를 것 없음'}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      {command && !needsScreen ? (
        <div className={styles.argForm}>
          {schema ? <p className={styles.muted}>더 고를 것 없이 바로 넣는 명령입니다.</p> : null}
          {ready && precheck && ready.commandKey !== 'rest' ? <PrecheckWarning query={precheck(ready)} /> : null}
          {/* 띠에서 누르면 바로 들어간다. 찾기로 고른 명령은 여기서 넣는다. */}
          {query.trim() !== '' ? <div className={styles.found}>{proposeButton ?? putButton}</div> : null}
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
          putButton={proposeButton ?? putButton}
          steps={argSteps}
          step={stepIndex}
          onStep={setArgStep}
        >
          <form
            id={formId}
            className={styles.argScreenForm}
            aria-label={`${command.name} 인자`}
            onSubmit={(e) => {
              e.preventDefault();
              submitArgs();
            }}
          >
            {cityDrill ? (
              <label className={styles.argLabel} {...stepProps('content')}>
                <span>
                  {command.key === 'recruit' || command.key === 'conscript' ? '모집 대상' : '훈련과 사기 대상'}
                </span>
                <select
                  value={preparationTarget}
                  onChange={(event) => {
                    choose(command.key, event.target.value === 'city' ? 'city' : 'unit');
                  }}
                >
                  <option value="unit">
                    {command.key === 'recruit' || command.key === 'conscript' ? '부곡' : '기존 부곡'}
                  </option>
                  <option value="city">현재 도시 수비병</option>
                </select>
              </label>
            ) : null}
            {command.key === 'equipment_trade' ? (
              <div className={styles.argScreenPanel} {...stepProps('content')}>
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
                <div className={`${styles.argScreenFields} ${styles.argScreenPanel}`} {...stepProps('content')}>
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
                  const picker = pickerFor(field);
                  return picker ? (
                    <div key={field.key} className={styles.argStep} {...stepProps(`f:${field.key}`)}>
                      {picker}
                    </div>
                  ) : null;
                })}
              </>
            )}
            {/* 확인 단계: 고른 값을 다시 보이고 군사의 조언을 듣는다 (D-100, 원작의 군사 조언). */}
            <div className={styles.argStep} {...stepProps('confirm')}>
              <AdvisorVerdict query={ready && precheck ? precheck(ready) : null} propose={propose?.to} />
            </div>
          </form>
        </CommandArgsScreen>
      ) : null}

      {/* 넣기 단추는 없다. 제안해야 하는 명령은 제안 칸을, 넣을 수 없는 명령은 이유를 적는다. */}
      {!needsScreen && command ? (
        proposeButton ? (
          <div className={styles.putRow}>{proposeButton}</div>
        ) : putReason !== null ? (
          <p className={styles.putReason} role="note">
            {putReason}
          </p>
        ) : null
      ) : null}
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
    field.kind === 'unit' ||
    field.kind === 'campaignUnit'
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
        ((field.kind === 'unit' || field.kind === 'campaignUnit') &&
          !field.options.some((option) => option.value === value)) ? (
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
// 군사 조언 상자: 사전 검사를 군사의 말로 옮긴다. 판정은 서버 사전 검사이고 실행할 때 다시 검사한다.
function AdvisorVerdict({ query, propose }: { query: SourceQuery<Check> | null; propose?: string | undefined }) {
  return (
    <section className={styles.advisor} aria-label="군사의 조언">
      {query ? (
        <AdvisorCheck query={query} propose={propose} />
      ) : (
        <p className={styles.advisorSays}>
          <b>군사</b> 칸을 다 채우면 실행할 수 있는지 살펴 드리겠습니다.
        </p>
      )}
    </section>
  );
}

function AdvisorCheck({ query, propose }: { query: SourceQuery<Check>; propose?: string | undefined }) {
  const check = useQuery({ queryKey: query.queryKey, queryFn: query.queryFn, select: query.select, retry: false });
  const verdict = check.isPending
    ? '살펴보는 중입니다.'
    : !check.data
      ? '지금은 판단하기 어렵습니다. 실행할 때 다시 살핍니다.'
      : check.data.ok
        ? '문제없이 실행할 수 있을 것으로 보입니다.'
        : `걱정되는 점이 있습니다. ${check.data.message}`;
  return (
    <p className={styles.advisorSays} data-ok={check.data?.ok ? 'true' : undefined}>
      <b>군사</b> {verdict}
      {propose ? ` 이 명령은 ${propose}에게 제안해 허가를 받아야 합니다.` : ''}
    </p>
  );
}

function PrecheckWarning({ query }: { query: SourceQuery<Check> }) {
  const check = useQuery({ queryKey: query.queryKey, queryFn: query.queryFn, select: query.select, retry: false });
  if (!check.data || check.data.ok) return null;
  return (
    <p className={styles.warn} role="status">
      사전 검사 경고: {check.data.message} 경고가 있어도 넣을 수 있습니다. 실행할 때 다시 검사합니다.
    </p>
  );
}
