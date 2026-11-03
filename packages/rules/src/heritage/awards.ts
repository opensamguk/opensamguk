import { heritageActivityMonths, type HeritageActivityInput } from './activity';
import { HERITAGE_V1 } from './constants';
import type { SeasonOutcome } from '../season';

export interface SeasonHeritageInput {
  reason: SeasonOutcome['reason'] | 'ADMIN_END' | 'ADMIN_RESET';
  winnerNationId: number | null;
  generals: readonly { userId: string | null; nationId: number | null }[];
  activity: readonly HeritageActivityInput[];
  endedSequence: number;
}
export interface SeasonHeritageAward {
  userId: string;
  activityMonths: number;
  activityPoints: number;
  winPoints: number;
  total: number;
}

export function seasonHeritageAwards(input: SeasonHeritageInput): SeasonHeritageAward[] {
  if (input.reason === 'ADMIN_END' || input.reason === 'ADMIN_RESET') return [];
  if (input.reason === 'UNIFIED' && input.winnerNationId === null) throw new Error('통일 국가가 없습니다.');
  const activity = heritageActivityMonths(input.activity, input.endedSequence);
  const winners = new Set<string>();
  if (input.reason === 'UNIFIED')
    for (const general of input.generals)
      if (general.userId !== null && general.nationId === input.winnerNationId) winners.add(general.userId);
  const userIds = [...new Set([...activity.keys(), ...winners])].sort();
  return userIds.flatMap((userId) => {
    const activityMonths = activity.get(userId) ?? 0;
    const activityPoints = HERITAGE_V1.activityMonths.filter((threshold) => activityMonths >= threshold).length;
    const winPoints = winners.has(userId) ? HERITAGE_V1.winPoints : 0;
    const total = Math.min(HERITAGE_V1.perSeason, activityPoints + winPoints);
    return total > 0 ? [{ userId, activityMonths, activityPoints, winPoints, total }] : [];
  });
}
