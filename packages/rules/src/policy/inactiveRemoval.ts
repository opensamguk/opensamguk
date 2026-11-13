import { removeAdminGeneral } from '../admin/remove';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import { dissolveNation, reconcileNationLifecycle, transferRulership } from '../nationLifecycle/operations';
import type { RuleFeatureDefinition } from '../ruleRegistry';
import { PLAYER_AUTOPLAY_FEATURE, playerAutoplayWindow } from './index';

export const INACTIVE_REMOVAL_FEATURE = 'inactive-removal-v1';

export function inactiveRemovalTick(lastActiveTick: number, turnTermMinutes: number) {
  const expiry = playerAutoplayWindow(lastActiveTick, turnTermMinutes).expiresAtTick;
  return Math.ceil(expiry / TICKS_PER_MONTH) * TICKS_PER_MONTH;
}

export const inactiveRemovalFeature: RuleFeatureDefinition = {
  key: INACTIVE_REMOVAL_FEATURE,
  requires: [PLAYER_AUTOPLAY_FEATURE],
  conflicts: [],
  settleMonthly({ settled, tick }) {
    const policy = settled.policy!;
    const expired = Object.values(settled.state.generals)
      .filter((general) => {
        const active = policy.lastActiveTicks[general.id];
        return (
          general.userId !== null &&
          general.removedAt === undefined &&
          active !== undefined &&
          inactiveRemovalTick(active, policy.turnTermMinutes) <= tick
        );
      })
      .sort((a, b) => a.id - b.id);
    if (!expired.length) return { replay: settled, effects: [] };
    const excluded = new Set(expired.map(({ id }) => id));
    const removed: number[] = [];
    let replay = settled;
    for (const expiredGeneral of expired) {
      const next = structuredClone(replay);
      const general = next.state.generals[expiredGeneral.id]!;
      const nationId = general.nationId;
      if (nationId !== null && general.officerLevel === BALANCE.RULER_LEVEL) {
        const successor = Object.values(next.state.generals)
          .filter(
            (candidate) =>
              candidate.nationId === nationId &&
              !excluded.has(candidate.id) &&
              candidate.removedAt === undefined &&
              candidate.activeFromYear <= next.state.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH)),
          )
          .sort((a, b) => b.officerLevel - a.officerLevel || b.dedication - a.dedication || a.id - b.id)[0];
        if (successor) {
          transferRulership(next.state, nationId, general.id, successor.id);
          delete successor.officerCityKey;
        } else {
          dissolveNation(next.state, nationId);
        }
      }
      if (!removeAdminGeneral(next, general.id, tick)) continue;
      replay = next;
      removed.push(general.id);
    }
    if (removed.length) replay.state = reconcileNationLifecycle(replay.state, tick);
    return { replay, effects: removed };
  },
};
