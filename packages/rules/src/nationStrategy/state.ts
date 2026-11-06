import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';

export const NATION_STRATEGY_FEATURE = 'nation-strategy-v1';
export const STRATEGY_KEYS = ['nation_mobilize', 'nation_rivalry', 'nation_raid'] as const;
export type StrategyKey = (typeof STRATEGY_KEYS)[number];
const month = z.number().int().nonnegative();
export const nationStrategySchema = z.strictObject({
  version: z.literal(1),
  nations: z.record(
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .refine((key) => Number.isSafeInteger(Number(key))),
    z.strictObject({
      strategicUntil: month,
      commands: z.strictObject({
        nation_mobilize: month.optional(),
        nation_rivalry: month.optional(),
        nation_raid: month.optional(),
      }),
    }),
  ),
});
export type NationStrategyState = z.infer<typeof nationStrategySchema>;
export const initialNationStrategy = (): NationStrategyState => ({ version: 1, nations: {} });
export function strategyMonth(tick: number) {
  return Math.floor(month.parse(tick) / TICKS_PER_MONTH);
}
export function readNationStrategy(value: unknown, world: Pick<WorldView, 'ruleFeatures'>) {
  if (!world.ruleFeatures?.includes(NATION_STRATEGY_FEATURE)) {
    if (value != null) throw new Error('전략 기능을 끈 월드에 대기 상태가 있습니다.');
    return undefined;
  }
  return nationStrategySchema.parse(value);
}
