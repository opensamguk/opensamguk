import { z } from 'zod';
import { BALANCE } from '../balance';
import type { RecordedInput, ReplayState } from '../replay';

export const NATION_FINANCE_FEATURE = 'nation-finance-v1';
export const NATION_FINANCE_KIND = 'nation.setFinanceRates';
export const RANKED_PAYROLL_FEATURE = 'ranked-payroll-v1';

// core2026 c81d304, packages/logic/src/economy/nationIncome.ts. MIT (c) 2025 devsam.
export function salaryByDedication(dedication: number) {
  return 400 + Math.min(30, Math.ceil(Math.sqrt(Math.max(0, dedication)) / 10)) * 200;
}

export function rankedPayroll(members: readonly { dedication: number }[], salaryRate: number, resources: number) {
  const bases = members.map(({ dedication }) => salaryByDedication(dedication));
  const baseTotal = bases.reduce((sum, base) => sum + base, 0);
  const budget = Math.min(Math.round(baseTotal * salaryRate), resources);
  return bases.map((base) => Math.floor((base * budget) / baseTotal));
}
export const financeRatesSchema = z.strictObject({
  taxPercent: z.number().int().min(5).max(30),
  salaryPercent: z.number().int().min(20).max(200),
});
export const financeRatesInput = z.strictObject({
  nationId: z.number().int().positive().max(2_147_483_647),
  rates: financeRatesSchema,
});
export type FinanceRates = z.infer<typeof financeRatesSchema>;

export function storedFinanceRates(raw: unknown) {
  return raw == null ? undefined : financeRatesSchema.parse(raw);
}

export function financeRates(rates?: FinanceRates) {
  return {
    taxRate: rates ? rates.taxPercent / 100 : BALANCE.MONTHLY_TAX_RATE,
    salaryRate: rates ? rates.salaryPercent / 100 : BALANCE.MONTHLY_SALARY_RATE,
  };
}

export function applyFinanceRates(replay: ReplayState, input: RecordedInput): ReplayState {
  const request = financeRatesInput.parse(input.payload);
  const result = financeRatesInput.parse(input.result);
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  const nation = replay.state.nations[request.nationId];
  if (
    !actor ||
    actor.userId === null ||
    actor.removedAt !== undefined ||
    actor.nationId !== request.nationId ||
    actor.officerLevel < 5 ||
    !nation ||
    result.nationId !== request.nationId ||
    result.rates.taxPercent !== request.rates.taxPercent ||
    result.rates.salaryPercent !== request.rates.salaryPercent
  )
    throw new Error('국가 세율·지급률 변경 기록이 올바르지 않습니다.');
  const next = structuredClone(replay);
  next.state.nations[nation.id]!.financeRates = request.rates;
  return next;
}
