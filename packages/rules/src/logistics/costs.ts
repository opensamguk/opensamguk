import { z } from 'zod';
import type { DeepReadonly } from '../model/world';
import type { LogisticsConfig, LogisticsGoods } from './state';

const amountSchema = z.number().int().min(1).max(1_000_000);

export function recruitGoods(
  config: DeepReadonly<Pick<LogisticsConfig, 'recruitPer100'>>,
  armType: number,
  amount: number,
): LogisticsGoods {
  amountSchema.parse(amount);
  const per100 = config.recruitPer100[String(armType)];
  if (!per100) throw new Error('물류 모집 비용에 없는 병과입니다.');
  const units = Math.ceil(amount / 100);
  return { iron: per100.iron * units, wood: per100.wood * units, horses: per100.horses * units };
}
