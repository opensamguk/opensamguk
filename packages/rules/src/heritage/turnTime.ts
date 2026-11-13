import { z } from 'zod';
import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { RecordedInput, ReplayState } from '../replay';
import type { InitialGeneral } from '../world/bootstrap';
import { heritageSpecialtyResetCost } from './specialty';

export const HERITAGE_TURN_TIME_KIND = 'heritage.turnTime';
export const heritageTurnTimeInput = z.strictObject({ expectedCost: z.number().int().positive() });
export const heritageTurnTimeState = z.strictObject({
  resets: z.number().int().min(1).max(40),
  offset: z.number().int().min(0).lt(TICKS_PER_MONTH).nullable(),
});
export type HeritageTurnTimeState = z.infer<typeof heritageTurnTimeState>;

export function storedHeritageTurnTime(raw: unknown) {
  return raw == null ? {} : { heritageTurnTime: heritageTurnTimeState.parse(raw) };
}

export function heritageTurnTimeQuote(general: Pick<InitialGeneral, 'heritageTurnTime' | 'nextTurnTick'>) {
  const { resets, offset } = general.heritageTurnTime ?? { resets: 0, offset: null };
  const pendingTick = offset === null ? null : turnTickForSlot(general.nextTurnTick, offset, 1);
  return { cost: pendingTick === null ? heritageSpecialtyResetCost(resets) : null, pendingTick };
}

export function purchaseHeritageTurnTime(
  general: Pick<InitialGeneral, 'id' | 'heritageTurnTime' | 'nextTurnTick'>,
  seed: string,
  expectedCost: number,
) {
  if (heritageTurnTimeQuote(general).cost !== expectedCost) return null;
  const resets = (general.heritageTurnTime?.resets ?? 0) + 1;
  const previous = general.nextTurnTick % TICKS_PER_MONTH;
  const draw = rngFor(seed, 'heritage-turn-time', general.id, resets, previous).int(0, TICKS_PER_MONTH - 2);
  const offset = draw >= previous ? draw + 1 : draw;
  return { cost: expectedCost, heritageTurnTime: { resets, offset } };
}

export function turnTickForSlot(nextTurnTick: number, offset: number | null | undefined, slot: number) {
  if (slot === 0 || offset == null) return nextTurnTick + slot * TICKS_PER_MONTH;
  return (Math.floor(nextTurnTick / TICKS_PER_MONTH) + slot) * TICKS_PER_MONTH + offset;
}

export function advanceHeritageTurnTime(general: InitialGeneral, tick: number) {
  general.nextTurnTick = turnTickForSlot(tick, general.heritageTurnTime?.offset, 1);
  if (general.heritageTurnTime?.offset != null)
    general.heritageTurnTime = { ...general.heritageTurnTime, offset: null };
}

export function applyHeritageTurnTime(replay: ReplayState, input: RecordedInput, context?: { seed?: string }) {
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (!actor || actor.userId === null || actor.removedAt !== undefined || context?.seed === undefined)
    throw new Error('턴 시간 초기화 장수나 시드가 없습니다.');
  const { expectedCost } = heritageTurnTimeInput.parse(input.payload);
  const purchase = purchaseHeritageTurnTime(actor, context.seed, expectedCost);
  const result = z
    .strictObject({ cost: z.number().int().positive(), heritageTurnTime: heritageTurnTimeState })
    .parse(input.result);
  if (
    !purchase ||
    purchase.cost !== result.cost ||
    purchase.heritageTurnTime.resets !== result.heritageTurnTime.resets ||
    purchase.heritageTurnTime.offset !== result.heritageTurnTime.offset
  )
    throw new Error('턴 시간 초기화 결과가 다릅니다.');
  return {
    ...replay,
    state: {
      ...replay.state,
      generals: { ...replay.state.generals, [actor.id]: { ...actor, heritageTurnTime: result.heritageTurnTime } },
    },
  };
}
