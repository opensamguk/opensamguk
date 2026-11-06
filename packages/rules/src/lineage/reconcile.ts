import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { LINEAGE_MAX } from './config';
import { heirEligibility, lineageAlive } from './eligibility';

export class LineageRevisionLimitError extends Error {
  constructor() {
    super('가문 변경 번호 한도에 닿았습니다.');
  }
}

export function reconcileLineage(world: WorldView, tick: number) {
  const next = cloneWorld(world),
    state = next.lineage;
  if (!state) return next;
  const marriages = state.marriages.filter((row) => lineageAlive(next, row.a) && lineageAlive(next, row.b));
  const offers = state.offers.filter(
    (row) =>
      row.expiresTick > tick &&
      lineageAlive(next, row.fromId) &&
      lineageAlive(next, row.toId) &&
      next.generals[row.fromId]!.userId !== null &&
      next.generals[row.toId]!.userId !== null,
  );
  let changed = marriages.length !== state.marriages.length || offers.length !== state.offers.length;
  state.marriages = marriages;
  state.offers = offers;
  for (const [id, person] of Object.entries(state.persons)) {
    if (person.heirId !== null && heirEligibility(next, Number(id), person.heirId, tick)) {
      person.heirId = null;
      changed = true;
    }
  }
  if (changed) {
    if (state.revision === LINEAGE_MAX) throw new LineageRevisionLimitError();
    state.revision++;
  }
  return next;
}
