// core2026 c81d304, monthlyEventHandler.ts and che_군량매매.ts. MIT (c) 2025 devsam.
import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { InitialCity } from '../world/bootstrap';

export const RICE_MARKET_FEATURE = 'rice-market-v1';

export function riceMarketRate(
  seed: string,
  tick: number,
  city: Pick<InitialCity, 'cityKey' | 'kind' | 'level' | 'supplied'>,
): number | null {
  if (city.kind === 'PASS' || !city.supplied || city.level < 4) return null;
  const rng = rngFor(seed, 'randomizeCityTradeRate', Math.floor(tick / TICKS_PER_MONTH), city.cityKey);
  return rng.next() < Math.min(1, (city.level - 3) / 5) ? rng.int(95, 105) : null;
}

export function riceMarketTrade(amount: number, buy: boolean, rate: number, gold: number, rice: number) {
  const unit = rate / 100;
  if (buy) {
    const subtotal = Math.min(amount * unit, gold);
    const spent = Math.min(subtotal * 1.01, gold);
    const bought = spent < amount * unit * 1.01 ? spent / 1.01 / unit : amount;
    return { gold: -Math.round(spent), rice: Math.round(bought), tax: Math.floor(spent / 101) };
  }
  const sold = Math.min(amount, rice);
  const proceeds = sold * unit;
  return { gold: Math.round(proceeds * 0.99), rice: -sold, tax: Math.floor(proceeds / 100) };
}
