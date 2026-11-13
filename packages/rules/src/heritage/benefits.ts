import { z } from 'zod';
import type { RecordedInput, ReplayState } from '../replay';

export const HERITAGE_BENEFITS_FEATURE = 'heritage-benefits-v1';
export const HERITAGE_BENEFIT_KIND = 'heritage.purchase';
export const battleHeritageBenefits = ['critical', 'opponentCritical', 'tactics', 'opponentTactics'] as const;
export const heritageBenefitNames = {
  domesticSuccess: '내정 대성공 확률',
  domesticFailure: '내정 대실패 확률 감소',
  evasion: '전투 회피 확률',
  opponentEvasion: '상대 회피 확률 감소',
  critical: '전투 필살 확률',
  opponentCritical: '상대 필살 확률 감소',
  tactics: '전투계략 시도 확률',
  opponentTactics: '상대 전투계략 시도 확률 감소',
} as const;
const benefitKey = z.enum(
  Object.keys(heritageBenefitNames) as [keyof typeof heritageBenefitNames, ...(keyof typeof heritageBenefitNames)[]],
);
const level = z.number().int().min(1).max(5);
const benefits = z.strictObject({
  domesticSuccess: level.optional(),
  domesticFailure: level.optional(),
  evasion: level.optional(),
  opponentEvasion: level.optional(),
  critical: level.optional(),
  opponentCritical: level.optional(),
  tactics: level.optional(),
  opponentTactics: level.optional(),
});
export type HeritageBenefits = z.infer<typeof benefits>;
export const heritageBenefitInput = z.strictObject({ benefit: benefitKey, level });
const resultSchema = z.strictObject({
  ...heritageBenefitInput.shape,
  previous: z.number().int().min(0).max(4),
  cost: z.number().int().min(1).max(15),
});
export const heritageBenefitCosts = [0, 1, 3, 6, 10, 15] as const;

export function storedHeritageBenefits(enabled: boolean, value: unknown) {
  if (value == null) return {};
  if (!enabled) throw new Error('유산 혜택을 끈 월드에 구매 내역이 있습니다.');
  return { heritageBenefits: benefits.parse(value) };
}

export function heritagePurchase(state: HeritageBenefits | undefined, input: z.infer<typeof heritageBenefitInput>) {
  const previous = state?.[input.benefit] ?? 0;
  if (input.level <= previous) return null;
  return { ...input, previous, cost: heritageBenefitCosts[input.level]! - heritageBenefitCosts[previous]! };
}

export function applyHeritagePurchase(replay: ReplayState, input: RecordedInput): ReplayState {
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (!actor || actor.userId === null || actor.removedAt !== undefined)
    throw new Error('유산 혜택 구매 기록의 장수를 확인하세요.');
  const purchase = heritagePurchase(actor.heritageBenefits, heritageBenefitInput.parse(input.payload));
  const result = resultSchema.parse(input.result);
  if (
    !purchase ||
    purchase.benefit !== result.benefit ||
    purchase.level !== result.level ||
    purchase.previous !== result.previous ||
    purchase.cost !== result.cost
  )
    throw new Error('유산 혜택 구매 비용 또는 단계가 다릅니다.');
  return {
    ...replay,
    state: {
      ...replay.state,
      generals: {
        ...replay.state.generals,
        [actor.id]: { ...actor, heritageBenefits: { ...actor.heritageBenefits, [result.benefit]: result.level } },
      },
    },
  };
}
