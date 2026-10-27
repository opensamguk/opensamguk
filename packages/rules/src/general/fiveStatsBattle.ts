import type { BattleModifiers } from '../modifiers';
import { fiveStatsSchema, type FiveStats } from './fiveStats';

// D-038: 실제 지휘관의 두 보정만 한 번 쓴다. 지휘관 없는 성벽은 호출하지 않는다.
export function fiveStatsBattleModifiers(stats: FiveStats): Required<BattleModifiers> {
  const parsed = fiveStatsSchema.parse(stats);
  return {
    dealt: [{ source: 'five_stats:strength', op: 'mul', value: 0.9 + parsed.strength / 500 }],
    taken: [{ source: 'five_stats:leadership', op: 'mul', value: 1.1 - parsed.leadership / 500 }],
  };
}
