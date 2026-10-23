import {
  ARCHIVE_CAPS,
  applyCapsRecordedInput,
  assertReplayPolicy,
  buildYearbook,
  capsResourceHashInput,
  monthlyDate,
  nextGameAction,
  parseCapsOrigin,
  policyFormatSchema,
  policyMarkerResultSchema,
  presetSchema,
  runCapsReplayAction,
  seasonOutcome,
  selectSupportedCapabilities,
  startCapsReplay,
  statRulesSchema,
  TICKS_PER_MONTH,
  toGameDate,
  unitSetSchema,
  validateCapsRecordedInput,
  type CapabilitySelection,
  type CapsOrigin,
  type PolicyFormat,
  type RecordedInput,
  type ReplayState,
  type WorldInit,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import type { ReplayArchiveV2, ReplayEnd } from './replay';

export interface CapsArchive extends Omit<ReplayArchiveV2, 'version' | 'origin' | 'config'> {
  version: typeof ARCHIVE_CAPS;
  origin: CapsOrigin;
  config: ReplayArchiveV2['config'] & { policy?: PolicyFormat };
}

type Check = (value: unknown) => boolean;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;
const sequence = (value: unknown) => positive(value) && value <= 2_147_483_647;
const string = (value: unknown): value is string => typeof value === 'string';
const name = (value: unknown) => string(value) && value.length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const list =
  (check: Check, minimum = 0): Check =>
  (value) =>
    Array.isArray(value) && value.length >= minimum && value.every(check);
const numericKey = (value: string) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
const record =
  (check: Check): Check =>
  (value) =>
    object(value) && Object.entries(value).every(([key, entry]) => numericKey(key) && check(entry));
function shape(required: Record<string, Check>, optional: Record<string, Check> = {}) {
  return (value: unknown): value is Record<string, unknown> =>
    object(value) &&
    Object.keys(required).every((key) => Object.hasOwn(value, key) && required[key]!(value[key])) &&
    Object.keys(value).every(
      (key) => Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]!(value[key])),
    );
}
const citySchema = shape({
  cityKey: positive,
  name,
  level: natural,
  region: natural,
  x: finite,
  y: finite,
  connections: list(positive),
  nationId: nullable(positive),
  population: natural,
  populationMax: natural,
  agriculture: natural,
  agricultureMax: natural,
  commerce: natural,
  commerceMax: natural,
  security: natural,
  securityMax: natural,
  defence: natural,
  defenceMax: natural,
  wall: natural,
  wallMax: natural,
  trust: (v) => finite(v) && v >= 0 && v <= 100,
  supplied: (v) => typeof v === 'boolean',
});
const nationSchema = shape({
  id: positive,
  name,
  color: (v) => string(v) && /^#[0-9a-fA-F]{6}$/.test(v),
  gold: natural,
  rice: natural,
  description: string,
  tech: (v) => finite(v) && v >= 0,
  philosophy: string,
  level: (v) => natural(v) && v <= 7,
  capitalCityKey: positive,
  isNpc: (v) => typeof v === 'boolean',
});
const generalFields = shape({
  id: positive,
  userId: nullable(name),
  affinity: natural,
  name,
  portraitId: nullable(positive),
  nationId: nullable(positive),
  cityKey: positive,
  leadership: (v) => natural(v) && v <= 100,
  strength: (v) => natural(v) && v <= 100,
  intel: (v) => natural(v) && v <= 100,
  officerLevel: (v) => natural(v) && v <= 12,
  birthYear: natural,
  deathYear: natural,
  activeFromYear: natural,
  personality: nullable(string),
  special: nullable(string),
  gold: natural,
  rice: natural,
  crew: natural,
  crewType: positive,
  train: natural,
  atmos: natural,
  experience: natural,
  dedication: natural,
  age: natural,
  injury: natural,
  nextTurnTick: natural,
});
const generalSchema: Check = (value) =>
  generalFields(value) && (value.birthYear as number) <= (value.deathYear as number);
const statSchema = statRulesSchema.shape.stat.strict();
const unitsSchema = unitSetSchema.strict();
const crewSchema = unitSetSchema.shape.crewTypes.element.strict();
const initialSchema = shape(
  {
    seed: name,
    scenarioKey: name,
    mapKey: name,
    unitSetKey: name,
    startYear: natural,
    statRules: (v) => statSchema.safeParse(v).success,
    unitSet: (v) =>
      unitsSchema.safeParse(v).success &&
      object(v) &&
      list((crew) => crewSchema.safeParse(crew).success, 1)(v.crewTypes),
    cities: list(citySchema, 1),
    nations: list(nationSchema),
    generals: list(generalSchema),
    diplomacies: list(
      shape({
        nationA: positive,
        nationB: positive,
        state: (v) => ['WAR', 'DECLARED', 'NON_AGGRESSION'].includes(v as string),
        untilTick: natural,
      }),
    ),
  },
  {
    presetRules: shape({
      protection: (v) => presetSchema.shape.protection.safeParse(v).success,
      npc: shape({ aggression: (v) => presetSchema.shape.npc.shape.aggression.safeParse(v).success }),
      boost: (v) => presetSchema.shape.boost.safeParse(v).success,
    }),
    commandMeta: shape({ nextNationId: positive, offers: record(positive) }),
    // args의 JSON 형태는 assertJson이 검사한다. 명령별 해석을 여기서 더하지 않는다.
    nationTurns: record(list(shape({ commandKey: name, args: (v) => v !== undefined }))),
  },
);
const endFields = shape({
  sequence,
  tick: natural,
  reason: (v) => v === 'UNIFIED' || v === 'END_YEAR',
  winnerNationId: nullable(positive),
  year: natural,
  month: (v) => positive(v) && v <= 12,
  finalStateHash: string,
});
const endSchema: Check = (value) =>
  endFields(value) && (value.reason === 'UNIFIED' ? value.winnerNationId !== null : value.winnerNationId === null);
const monthSchema = shape({
  tick: positive,
  year: natural,
  month: (v) => positive(v) && v <= 12,
  sequence,
  stateHash: string,
  data: shape({
    nations: list(
      shape({ nationId: positive, cities: natural, generals: natural, power: natural, gold: natural, rice: natural }),
    ),
    cities: list(shape({ cityKey: positive, nationId: nullable(positive) })),
  }),
});
const archiveSchema = shape({
  version: (v) => v === ARCHIVE_CAPS,
  origin: shape({
    version: (v) => v === 6,
    initial: initialSchema,
    initialStateHash: string,
    resourceHash: string,
    capabilities: object,
  }),
  config: shape(
    { endYear: nullable((v) => natural(v) && v <= 10000), outcomeFromSequence: natural },
    { policy: (v) => policyFormatSchema.safeParse(v).success },
  ),
  // 계열별 기록은 validateCapsRecordedInput에 맡긴다.
  inputs: list(object),
  months: list(monthSchema),
  end: nullable(endSchema),
  afterEnd: list(object),
});

// JSON에 없는 속성이나 값을 해시·스키마 검사가 조용히 버리지 않게 한다.
function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new Error('보관 파일은 JSON이어야 합니다.');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('보관 파일의 객체를 확인하세요.');
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (
    array &&
    (keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length),
      ))
  )
    throw new Error('보관 파일의 배열을 확인하세요.');
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value'))
      throw new Error('보관 파일의 속성을 확인하세요.');
    assertJson(property.value, ancestors);
  }
  ancestors.delete(value);
}

function checkInitial(initial: WorldInit): void {
  const unique = (ids: number[]) => {
    const set = new Set(ids);
    if (set.size !== ids.length) throw new Error('생성 기록의 ID가 겹칩니다.');
    return set;
  };
  const cities = unique(initial.cities.map((city) => city.cityKey));
  const nations = unique(initial.nations.map((nation) => nation.id));
  unique(initial.generals.map((general) => general.id));
  if (
    initial.cities.some(
      (city) =>
        (city.nationId !== null && !nations.has(city.nationId)) || city.connections.some((key) => !cities.has(key)),
    ) ||
    initial.nations.some((nation) => !cities.has(nation.capitalCityKey)) ||
    initial.generals.some(
      (general) => !cities.has(general.cityKey) || (general.nationId !== null && !nations.has(general.nationId)),
    ) ||
    initial.diplomacies.some(
      (pair) => pair.nationA >= pair.nationB || !nations.has(pair.nationA) || !nations.has(pair.nationB),
    )
  )
    throw new Error('생성 기록의 도시·국가 참조를 확인하세요.');
}

function assertArchiveStructure(value: unknown): asserts value is CapsArchive {
  if (!archiveSchema(value)) throw new Error('형식 6 보관 파일과 초기 상태의 구조를 확인하세요.');
}

export function readCapsArchive(value: unknown): CapsArchive {
  assertJson(value);
  // parse 출력은 사용하지 않는다. 해시가 걸린 원문을 고치지 않는 검사다.
  assertArchiveStructure(value);
  const archive = value;
  checkInitial(archive.origin.initial);
  const origin = parseCapsOrigin(archive.origin);
  const selection = selectSupportedCapabilities(origin, archive.config);
  const coverage = archive.end?.sequence ?? archive.months.at(-1)?.sequence ?? 0;
  let previous = 0;
  for (const [index, month] of archive.months.entries()) {
    const tick = (index + 1) * TICKS_PER_MONTH;
    const date = monthlyDate(origin.initial.startYear, tick);
    if (
      month.tick !== tick ||
      month.year !== date.year ||
      month.month !== date.month ||
      month.sequence <= previous ||
      month.sequence > coverage ||
      (archive.end && month.tick > archive.end.tick)
    )
      throw new Error('형식 6 월간 기록의 경계·순서를 확인하세요.');
    previous = month.sequence;
  }
  const monthSequences = new Set(archive.months.map((month) => month.sequence));
  previous = 0;
  let markers = 0;
  for (const input of archive.inputs) {
    const checked = validateCapsRecordedInput(input, { selection, monthlyTick: 0 });
    if (
      checked.sequence <= previous ||
      checked.sequence > coverage ||
      monthSequences.has(checked.sequence) ||
      checked.sequence === archive.end?.sequence
    )
      throw new Error('형식 6 입력 기록의 순서를 확인하세요.');
    previous = checked.sequence;
    if (checked.kind === 'system.policy.enable') markers++;
  }
  const from = selection.policy?.fromSequence ?? 0;
  if (markers !== (from > 0 && from <= coverage ? 1 : 0)) throw new Error('방침 전환 표지 수를 확인하세요.');
  previous = coverage;
  for (const input of archive.afterEnd) {
    if (!archive.end) throw new Error('종료 없는 뒤 입력 기록입니다.');
    const checked = validateCapsRecordedInput(input, {
      selection,
      monthlyTick: archive.months.at(-1)?.tick ?? 0,
      endTick: archive.end.tick,
    });
    if (checked.sequence <= previous) throw new Error('종료 뒤 입력 기록의 순서를 확인하세요.');
    previous = checked.sequence;
  }
  if (
    origin.initialStateHash !== hashState(origin.initial) ||
    origin.resourceHash !== hashState(capsResourceHashInput(origin))
  )
    throw new Error('형식 6 생성 기록 또는 자원 해시가 다릅니다.');
  return structuredClone(archive);
}

function outcome(
  archive: CapsArchive,
  replay: ReplayState,
  at: number,
  action: ReturnType<typeof nextGameAction>,
): void {
  const date =
    action.kind === 'monthly'
      ? monthlyDate(replay.state.startYear, action.tick)
      : toGameDate(replay.state.startYear, action.tick);
  const found =
    at > archive.config.outcomeFromSequence
      ? seasonOutcome(replay.state, {
          endYear: archive.config.endYear,
          ...(action.kind === 'monthly' ? { settled: date } : {}),
        })
      : null;
  const end = archive.end;
  if (!end || at < end.sequence) {
    if (found) throw new Error('기록한 순서보다 먼저 종료됐습니다.');
    return;
  }
  if (
    at !== end.sequence ||
    !found ||
    found.reason !== end.reason ||
    found.winnerNationId !== end.winnerNationId ||
    action.tick !== end.tick ||
    (end.reason === 'END_YEAR' && action.kind !== 'monthly') ||
    date.year !== end.year ||
    date.month !== end.month ||
    hashState(replay) !== end.finalStateHash
  )
    throw new Error('형식 6 종료 사건과 해시가 다릅니다.');
}

function monthHash(replay: ReplayState, expected: CapsArchive['months'][number]): string {
  assertReplayPolicy(replay);
  const stateHash = hashState(replay);
  if (
    replay.monthlyTick !== expected.tick ||
    stateHash !== expected.stateHash ||
    hashState(buildYearbook(replay.state, expected.year)) !== hashState(expected.data)
  )
    throw new Error('형식 6 월간 해시가 다릅니다.');
  return stateHash;
}

function walker(archive: CapsArchive) {
  const selection = selectSupportedCapabilities(archive.origin, archive.config);
  let replay = startCapsReplay(archive.origin, selection);
  const untouched = new Set(archive.origin.initial.generals.map((general) => general.id));
  const inputs = new Map(archive.inputs.map((input) => [input.sequence, input]));
  let lastActionTick = 0;
  let lastRecordedTick = 0;
  let at = 0;
  let monthIndex = 0;
  const hashes: { tick: number; stateHash: string }[] = [];

  function apply(input: RecordedInput, context: { selection: CapabilitySelection; endTick?: number }) {
    if (input.kind === 'system.policy.enable') {
      const result = policyMarkerResultSchema.parse(input.result);
      const expected = [...untouched].filter((id) => replay.state.generals[id]).sort((a, b) => a - b);
      if (
        JSON.stringify(expected) !== JSON.stringify(result.emptySlots) ||
        result.clockTick < lastActionTick ||
        expected.some((id) =>
          replay.turns[id]!.some(
            (turn) =>
              Reflect.ownKeys(turn).length !== 2 || turn.commandKey !== 'rest' || JSON.stringify(turn.args) !== '{}',
          ),
        )
      )
        throw new Error('방침 전환 전 칸 집합이나 시계가 다릅니다.');
    }
    if (input.kind === 'treaty.propose' || input.kind === 'treaty.respond') {
      const tick = (input.result as { tick: number }).tick;
      if (tick < lastRecordedTick) throw new Error('조약 기록의 tick이 되돌아갑니다.');
      lastRecordedTick = tick;
    }
    if (input.status === 'APPLIED' && input.kind === 'turns.set' && input.generalId !== null)
      untouched.delete(input.generalId);
    replay = applyCapsRecordedInput(replay, input, context);
  }

  return {
    hashes,
    advance(limit: number) {
      while (at < limit) {
        const input = inputs.get(++at);
        if (input) {
          apply(input, { selection });
          continue;
        }
        if (selection.policy?.fromSequence === at) throw new Error('방침 전환 순서에 표지가 없습니다.');
        const action = nextGameAction(replay);
        const expected = archive.months[monthIndex];
        if (
          (archive.end && action.tick > archive.end.tick) ||
          (action.kind === 'monthly' && (!expected || expected.tick !== action.tick || expected.sequence !== at)) ||
          (action.kind !== 'monthly' && expected && at >= expected.sequence)
        )
          throw new Error('형식 6 정산 순서가 다릅니다.');
        replay = runCapsReplayAction(replay, archive.origin.initial.seed, archive.origin.initial.unitSet, selection);
        lastActionTick = action.tick;
        lastRecordedTick = Math.max(lastRecordedTick, action.tick);
        if (action.kind === 'turn') untouched.delete(action.generalId);
        else {
          hashes.push({ tick: expected!.tick, stateHash: monthHash(replay, expected!) });
          monthIndex++;
        }
        outcome(archive, replay, at, action);
      }
    },
    finish(): ReplayEnd {
      if (!archive.end || at !== archive.end.sequence || monthIndex !== archive.months.length)
        throw new Error('종료 뒤 월간 기록이 있습니다.');
      for (const input of archive.afterEnd) apply(input, { selection, endTick: archive.end.tick });
      return { ...archive.end, finalStateHash: hashState(replay) };
    },
  };
}

export function replayCapsArchive(value: unknown, months = 12): { tick: number; stateHash: string }[] {
  if (!Number.isSafeInteger(months) || months < 1 || months > 12000) throw new Error('재생 개월 수를 확인하세요.');
  const archive = readCapsArchive(value);
  if (archive.months.length < months) throw new Error('비교할 월간 기록이 부족합니다.');
  const replay = walker(archive);
  replay.advance(archive.months[months - 1]!.sequence);
  return replay.hashes;
}

export function replayCapsToEnd(value: unknown): ReplayEnd {
  const archive = readCapsArchive(value);
  if (!archive.end) throw new Error('형식 6 종료 기록이 필요합니다.');
  const replay = walker(archive);
  replay.advance(archive.end.sequence);
  return replay.finish();
}
