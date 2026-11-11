import { lineageActive, lineageAlive } from '../lineage/eligibility';
import { LineageRevisionLimitError } from '../lineage/reconcile';
import { GovernanceRevisionLimitError } from '../governance/reconcile';
import {
  dissolveNation,
  NationLifecycleRevisionLimitError,
  reconcileNationLifecycle,
  transferRulership,
} from '../nationLifecycle/operations';
import type { ReplayState } from '../replay';
import type { AdminGameAction, AdminGameRejectCode } from './game';

type NationAction = Extract<AdminGameAction, { kind: 'admin.nation.setRuler' | 'admin.nation.disband' }>;

// 운영자는 명령 권한·방랑·첫 달 조건만 건너뛰고 같은 전이와 후처리를 쓴다.
export function applyAdminNation(
  replay: ReplayState,
  action: NationAction,
  tick: number,
): AdminGameRejectCode | undefined {
  if (action.kind === 'admin.nation.setRuler' || action.expected !== undefined) {
    const ruler = Object.values(replay.state.generals).find(
      (general) =>
        general.nationId === action.nationId && general.officerLevel === 12 && lineageAlive(replay.state, general.id),
    );
    if (action.kind === 'admin.nation.setRuler') {
      if (ruler?.id !== action.expectedRulerId) return 'TARGET_CHANGED';
      const target = replay.state.generals[action.generalId]!;
      if (
        target.nationId !== action.nationId ||
        target.id === ruler.id ||
        !lineageActive(replay.state, target.id, tick)
      )
        return 'INVALID_VALUE';
      transferRulership(replay.state, action.nationId, ruler.id, target.id);
    } else if (
      action.expected &&
      (replay.state.nations[action.nationId]?.name !== action.expected.name ||
        (ruler?.id ?? null) !== action.expected.rulerId)
    ) {
      return 'TARGET_CHANGED';
    }
  }
  try {
    if (action.kind === 'admin.nation.disband') dissolveNation(replay.state, action.nationId);
    replay.state = reconcileNationLifecycle(replay.state, tick);
  } catch (error) {
    if (
      error instanceof GovernanceRevisionLimitError ||
      error instanceof LineageRevisionLimitError ||
      error instanceof NationLifecycleRevisionLimitError
    )
      return 'INVALID_VALUE';
    throw error;
  }
}
