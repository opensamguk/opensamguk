import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { monthlyDate } from '../monthly';

const maxTick = 2_147_483_647;
const maxMonth = Math.floor(maxTick / TICKS_PER_MONTH);
const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const option = z.union([z.literal(0), z.literal(1)]);
const nation = z.strictObject({ nationId: z.number().int().positive(), name: z.string().min(1) });
const monthlyTick = z
  .number()
  .int()
  .positive()
  .max(maxTick)
  .refine((tick) => tick % TICKS_PER_MONTH === 0);
const months = z.number().int().positive().max(maxMonth);
const effect = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('gold'), value: z.number().int() }),
  z.strictObject({ kind: z.literal('rice'), value: z.number().int() }),
  z.strictObject({ kind: z.literal('atmos'), value: z.number().int() }),
  z.strictObject({ kind: z.literal('nonAggression'), months }),
]);
const eventOption = z.strictObject({ label: z.string().min(1), effects: z.array(effect) });
const event = z.strictObject({
  id: eventId,
  year: z.number().int().min(0).max(10_000),
  month: z.number().int().min(1).max(12),
  chooser: nation,
  counterpart: nation.nullable(),
  title: z.string().min(1),
  text: z.string().min(1),
  options: z.tuple([eventOption, eventOption]),
  defaultOption: option,
  ref: z.string().min(1),
});
const configSchema = z.strictObject({ events: z.array(event), windowMonths: months });
const stateSchema = z.strictObject({
  pending: z.array(
    z.strictObject({
      id: eventId,
      nationId: z.number().int().positive(),
      firedTick: monthlyTick,
      closesAtMonth: months,
      choice: option.nullable(),
    }),
  ),
  done: z.array(
    z.strictObject({
      id: eventId,
      nationId: z.number().int().positive(),
      choice: option.nullable(),
      defaulted: z.boolean(),
      resolvedTick: monthlyTick,
    }),
  ),
  skipped: z.array(eventId),
});
export const historicEventChoiceSchema = z.strictObject({ eventId, option });
export type HistoricEventsConfig = z.infer<typeof configSchema>;
export type HistoricEventsState = z.infer<typeof stateSchema>;

function eventMonth(startYear: number, row: Pick<HistoricEventsConfig['events'][number], 'year' | 'month'>) {
  return (row.year - startYear) * 12 + row.month;
}

export function readHistoricEventsConfig(
  initial: { startYear: number; nations: readonly { id: number; name: string }[] },
  value: unknown,
) {
  const config = configSchema.parse(value);
  const nations = new Map(initial.nations.map(({ id, name }) => [id, name]));
  const ids = new Set<string>();
  for (const row of config.events) {
    if (ids.has(row.id)) throw new Error('역사 사건 ID가 겹칩니다.');
    ids.add(row.id);
    const month = eventMonth(initial.startYear, row);
    if (month < 1 || month + config.windowMonths > maxMonth) throw new Error('역사 사건의 발생·기한 월이 다릅니다.');
    if (
      nations.get(row.chooser.nationId) !== row.chooser.name ||
      (row.counterpart &&
        (nations.get(row.counterpart.nationId) !== row.counterpart.name ||
          row.counterpart.nationId === row.chooser.nationId))
    )
      throw new Error('역사 사건의 국가가 생성 자료와 다릅니다.');
    if (!row.counterpart && row.options.some(({ effects }) => effects.some(({ kind }) => kind === 'nonAggression')))
      throw new Error('불가침 효과에는 상대 국가가 필요합니다.');
  }
  return config;
}

export const initialHistoricEvents = (): HistoricEventsState => ({ pending: [], done: [], skipped: [] });

export function readHistoricEventsState(value: unknown, config: HistoricEventsConfig, startYear: number) {
  const state = stateSchema.parse(value);
  const events = new Map(config.events.map((row) => [row.id, row]));
  const ids = [...state.pending.map(({ id }) => id), ...state.done.map(({ id }) => id), ...state.skipped];
  if (new Set(ids).size !== ids.length || ids.some((id) => !events.has(id)))
    throw new Error('역사 사건 상태의 ID를 확인하세요.');
  for (const pending of state.pending) {
    const row = events.get(pending.id)!;
    const month = eventMonth(startYear, row);
    if (
      pending.nationId !== row.chooser.nationId ||
      pending.firedTick !== month * TICKS_PER_MONTH ||
      pending.closesAtMonth !== month + config.windowMonths
    )
      throw new Error('열린 역사 사건의 발생·기한을 확인하세요.');
  }
  for (const done of state.done) {
    const row = events.get(done.id)!;
    if (
      done.nationId !== row.chooser.nationId ||
      done.resolvedTick < (eventMonth(startYear, row) + config.windowMonths) * TICKS_PER_MONTH ||
      (done.defaulted && done.choice !== null && done.choice !== row.defaultOption) ||
      (!done.defaulted && done.choice === null)
    )
      throw new Error('끝난 역사 사건의 처리 결과를 확인하세요.');
  }
  return state;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function settleHistoricEvents(
  state: HistoricEventsState,
  config: HistoricEventsConfig,
  context: { startYear: number; tick: number; nationExists: (id: number) => boolean },
) {
  const { startYear, tick, nationExists } = context;
  const date = monthlyDate(startYear, tick);
  const month = tick / TICKS_PER_MONTH;
  const events = new Map(config.events.map((row) => [row.id, row]));
  const seen = new Set([...state.pending.map(({ id }) => id), ...state.done.map(({ id }) => id), ...state.skipped]);
  const pending = state.pending.filter((row) => row.closesAtMonth > month);
  const resolved = state.pending
    .filter((row) => row.closesAtMonth <= month)
    .sort(byId)
    .map(({ id, nationId, choice }) => {
      const exists = nationExists(nationId);
      return {
        id,
        nationId,
        choice: exists ? (choice ?? events.get(id)!.defaultOption) : null,
        defaulted: !exists || choice === null,
        resolvedTick: tick,
      };
    });
  const skipped = [...state.skipped];
  const opened: HistoricEventsState['pending'] = [];
  for (const { id, chooser } of config.events
    .filter((row) => row.year === date.year && row.month === date.month && !seen.has(row.id))
    .sort(byId)) {
    if (!nationExists(chooser.nationId)) {
      skipped.push(id);
      continue;
    }
    opened.push({
      id,
      nationId: chooser.nationId,
      firedTick: tick,
      closesAtMonth: month + config.windowMonths,
      choice: null,
    });
  }
  return { state: { pending: [...pending, ...opened], done: [...state.done, ...resolved], skipped }, resolved, opened };
}

type Actor = { generalId: number; nationId: number };
export function chooseHistoricEvent(
  state: HistoricEventsState | undefined,
  input: z.infer<typeof historicEventChoiceSchema>,
  actor: Actor | null,
  tick: number,
  isChooser: (actor: Actor) => boolean,
) {
  if (!state) return { code: 'FEATURE_DISABLED' as const };
  if (!actor) return { code: 'NO_GENERAL' as const };
  const event = state.pending.find(({ id }) => id === input.eventId);
  if (!event || !Number.isSafeInteger(tick) || tick < event.firedTick || tick >= event.closesAtMonth * TICKS_PER_MONTH)
    return { code: 'EVENT_CLOSED' as const };
  if (event.nationId !== actor.nationId) return { code: 'NOT_YOUR_EVENT' as const };
  if (!isChooser(actor)) return { code: 'NOT_CHOOSER' as const };
  if (event.choice !== null) return { code: 'ALREADY_CHOSEN' as const };
  return {
    state: {
      ...state,
      pending: state.pending.map((row) => (row.id === event.id ? { ...row, choice: input.option } : row)),
    },
  };
}
