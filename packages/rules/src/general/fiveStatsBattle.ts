import type { BattleModifiers } from '../modifiers';
import { fiveStatsSchema, type FiveStats } from './fiveStats';

const commanderStatsSchema = fiveStatsSchema.pick({ leadership: true, strength: true });
export type CommanderBattleStats = Pick<FiveStats, 'leadership' | 'strength'>;

// 단일 교전 미리보기는 피해에 쓰는 두 값만 받으며 다른 능력치를 만들어 채우지 않는다.
export function commanderBattleModifiers(stats: CommanderBattleStats): Required<BattleModifiers> {
  const parsed = commanderStatsSchema.parse(stats);
  return {
    dealt: [{ source: 'five_stats:strength', op: 'mul', value: 0.9 + parsed.strength / 500 }],
    taken: [{ source: 'five_stats:leadership', op: 'mul', value: 1.1 - parsed.leadership / 500 }],
  };
}

// D-038: 실제 지휘관의 두 보정만 한 번 쓴다. 지휘관 없는 성벽은 호출하지 않는다.
export function fiveStatsBattleModifiers(stats: FiveStats): Required<BattleModifiers> {
  const parsed = fiveStatsSchema.parse(stats);
  return commanderBattleModifiers({ leadership: parsed.leadership, strength: parsed.strength });
}
