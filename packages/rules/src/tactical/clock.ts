import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';

export function tacticalClock(view: WorldView, action: 'pause' | 'resume' | 'start', at: number) {
  const state = cloneWorld(view);
  for (const b of state.campaign?.tactical?.battles ?? []) {
    if (b.settled) continue;
    if (action === 'pause' && b.pausedAt === null) b.pausedAt = at;
    if (action === 'resume' && b.pausedAt !== null) {
      const elapsed = Math.max(0, at - b.pausedAt);
      if (b.deadlineAt) b.deadlineAt += elapsed;
      if (b.hardDeadlineAt) b.hardDeadlineAt += elapsed;
      b.pausedAt = null;
    }
  }
  return state;
}
