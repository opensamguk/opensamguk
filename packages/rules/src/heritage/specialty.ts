import { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import { domesticSpecialty, domesticSpecialtyNames, DOMESTIC_SPECIALTY_FEATURE } from '../general/domesticSpecialty';
import { combatSpecialty, combatSpecialtyKey, combatSpecialtyNames } from '../general/combatSpecialty';
import type { WorldState, WorldView } from '../model/world';
import type { RecordedInput, ReplayState } from '../replay';

export const SPECIALTY_GROWTH_FEATURE = 'specialty-growth-v1';
export const HERITAGE_SPECIALTY_FEATURE = 'heritage-specialty-v1';
export const HERITAGE_SPECIALTY_KIND = 'heritage.combatSpecialty';
export const heritageSpecialtyCost = 4_000;
const maxPoints = 2_147_483_647;
const specialty = z.enum(combatSpecialtyNames);
export const heritageSpecialtyInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('reserve'), specialty }),
  z.strictObject({ action: z.literal('reset') }),
]);
export const heritageSpecialtyState = z.strictObject({
  next: specialty.nullable(),
  resets: z.number().int().min(0).max(40),
});
export type HeritageSpecialtyState = z.infer<typeof heritageSpecialtyState>;
export type HeritageSpecialtyInput = z.infer<typeof heritageSpecialtyInput>;

export function storedHeritageSpecialty(enabled: boolean, value: unknown) {
  if (value == null) return {};
  if (!enabled) throw new Error('전투 특기 유산을 끈 월드에 저장 상태가 있습니다.');
  return { heritageSpecialty: heritageSpecialtyState.parse(value) };
}

export function heritageSpecialtyResetCost(resets: number) {
  const costs = [1_000, 1_000, 2_000, 3_000];
  while (costs.length <= resets) costs.push(costs.at(-1)! + costs.at(-2)!);
  const cost = costs[resets]!;
  return cost <= maxPoints ? cost : null;
}

export function heritageSpecialtyPurchase(
  view: Pick<WorldView, 'ruleFeatures'>,
  general: { special: string | null; combatSpecial?: string | null; heritageSpecialty?: HeritageSpecialtyState },
  input: HeritageSpecialtyInput,
) {
  const state = general.heritageSpecialty ?? { next: null, resets: 0 };
  const current = combatSpecialty(view, combatSpecialtyKey(general));
  if (input.action === 'reserve') {
    if (state.next || current?.name === input.specialty) return null;
    return {
      cost: heritageSpecialtyCost,
      combatSpecial: combatSpecialtyKey(general),
      heritageSpecialty: { ...state, next: input.specialty },
    };
  }
  const cost = heritageSpecialtyResetCost(state.resets);
  if (!current || !cost) return null;
  return { cost, combatSpecial: null, heritageSpecialty: { ...state, resets: state.resets + 1 } };
}

export function applyHeritageSpecialtyPurchase(replay: ReplayState, input: RecordedInput): ReplayState {
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (!actor || actor.userId === null || actor.removedAt !== undefined)
    throw new Error('전투 특기 구매 장수가 없습니다.');
  const purchase = heritageSpecialtyPurchase(replay.state, actor, heritageSpecialtyInput.parse(input.payload));
  const result = z
    .strictObject({
      cost: z.number().int().positive(),
      combatSpecial: z.string().nullable(),
      heritageSpecialty: heritageSpecialtyState,
    })
    .parse(input.result);
  if (
    !purchase ||
    result.cost !== purchase.cost ||
    result.combatSpecial !== purchase.combatSpecial ||
    result.heritageSpecialty.next !== purchase.heritageSpecialty.next ||
    result.heritageSpecialty.resets !== purchase.heritageSpecialty.resets
  )
    throw new Error('전투 특기 구매 결과가 다릅니다.');
  return {
    ...replay,
    state: {
      ...replay.state,
      generals: {
        ...replay.state.generals,
        [actor.id]: { ...actor, combatSpecial: result.combatSpecial, heritageSpecialty: result.heritageSpecialty },
      },
    },
  };
}

// core2026 c81d304 monthlySpecialityBetrayAction.ts (MIT): maturity ages after the third season year.
function specialtyAge(general: WorldView['generals'][number], startYear: number, divisor: number) {
  const enteredYear = Math.max(startYear, general.activeFromYear);
  const startAge = Math.max(0, enteredYear - general.birthYear);
  const yearsIntoSeason = enteredYear - startYear;
  return startAge + Math.max(Math.round((80 - startAge) / divisor - yearsIntoSeason / 2), 3);
}

export function settleHeritageSpecialties(state: WorldState, year: number, rng: Rng) {
  const logs: { generalId: number; text: string }[] = [];
  if (!state.ruleFeatures?.includes(HERITAGE_SPECIALTY_FEATURE)) return logs;
  const growth = state.ruleFeatures.includes(SPECIALTY_GROWTH_FEATURE);
  if (growth) {
    if (year < state.startYear + 3) return logs;
    const generals = Object.values(state.generals)
      .filter(({ activeFromYear, removedAt }) => activeFromYear <= year && removedAt === undefined)
      .sort((a, b) => a.id - b.id);
    if (state.ruleFeatures.includes(DOMESTIC_SPECIALTY_FEATURE))
      for (const general of generals) {
        const age = year - general.birthYear;
        const combat = combatSpecialty(state, combatSpecialtyKey(general));
        if (domesticSpecialty(state, general.special) || age < specialtyAge(general, state.startYear, 12)) continue;
        if (combat && general.combatSpecial === undefined) {
          general.combatSpecial = combat.name;
          general.heritageSpecialty ??= { next: null, resets: 0 };
        }
        general.special = rng.pick(domesticSpecialtyNames);
        logs.push({ generalId: general.id, text: `내정 특기 【${general.special}】 습득` });
      }
    for (const general of generals) {
      if (
        combatSpecialty(state, combatSpecialtyKey(general)) ||
        year - general.birthYear < specialtyAge(general, state.startYear, 6)
      )
        continue;
      general.combatSpecial = general.heritageSpecialty?.next ?? rng.pick(combatSpecialtyNames);
      general.heritageSpecialty = { next: null, resets: general.heritageSpecialty?.resets ?? 0 };
      logs.push({ generalId: general.id, text: `전투 특기 【${general.combatSpecial}】 습득` });
    }
    return logs;
  }
  for (const general of Object.values(state.generals)) {
    const next = general.heritageSpecialty?.next;
    if (
      !next ||
      general.removedAt !== undefined ||
      general.activeFromYear > year ||
      combatSpecialty(state, combatSpecialtyKey(general))
    )
      continue;
    general.combatSpecial = next;
    general.heritageSpecialty = { ...general.heritageSpecialty!, next: null };
  }
  return logs;
}
