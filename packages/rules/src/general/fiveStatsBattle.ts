import type { BattleModifiers } from '../modifiers';
import { fiveStatsSchema, type FiveStats } from './fiveStats';

const commanderStatsSchema = fiveStatsSchema.pick({ leadership: true, strength: true });
const commanderBonusSchema = commanderStatsSchema.extend({
  leadership: commanderStatsSchema.shape.leadership.max(6),
  strength: commanderStatsSchema.shape.strength.max(6),
});
export type CommanderBattleStats = Pick<FiveStats, 'leadership' | 'strength'>;

// 단일 교전 미리보기는 피해에 쓰는 두 값만 받으며 다른 능력치를 만들어 채우지 않는다.
export function commanderBattleModifiers(
  stats: CommanderBattleStats,
  bonus?: CommanderBattleStats,
): Required<BattleModifiers> {
  const parsed = commanderStatsSchema.parse(stats);
  const equipment = bonus === undefined ? null : commanderBonusSchema.parse(bonus);
  return battleModifiersForEffectiveStats({
    strength: parsed.strength + (equipment?.strength ?? 0),
    leadership: parsed.leadership + (equipment?.leadership ?? 0),
  });
}

export function battleModifiersForEffectiveStats(stats: CommanderBattleStats): Required<BattleModifiers> {
  return {
    dealt: [{ source: 'five_stats:strength', op: 'mul', value: 0.9 + stats.strength / 500 }],
    taken: [
      {
        source: 'five_stats:leadership',
        op: 'mul',
        value: 1.1 - stats.leadership / 500,
      },
    ],
  };
}

// D-038: 실제 지휘관의 두 보정만 한 번 쓴다. 지휘관 없는 성벽은 호출하지 않는다.
export function fiveStatsBattleModifiers(stats: FiveStats, bonus?: CommanderBattleStats): Required<BattleModifiers> {
  const parsed = fiveStatsSchema.parse(stats);
  return commanderBattleModifiers({ leadership: parsed.leadership, strength: parsed.strength }, bonus);
}
