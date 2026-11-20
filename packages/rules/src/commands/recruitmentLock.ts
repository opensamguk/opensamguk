import { toGameDate } from '../clock/clock';
import type { WorldState } from '../model/world';

export function applyLastNationRecruitmentLock(
  state: WorldState,
  defendingNationId: number | null | undefined,
  tick: number,
) {
  const lock = state.commandMeta?.lastNationRecruitmentLock;
  if (lock === undefined || lock.blockedNationId !== undefined) return;
  if (
    defendingNationId == null ||
    state.nations[defendingNationId] ||
    toGameDate(state.startYear, tick).year < lock.fromYear
  )
    return;
  const remaining = Object.values(state.nations);
  if (remaining.length === 1) lock.blockedNationId = remaining[0]!.id;
}
