import { emptyQueue } from '../policy';
import { emptyTurns } from '../replayInputs';
import type { RecordedInput, ReplayState } from '../replay';
import { updateResidenceAnchors } from '../personnel/residence';
import { LINEAGE_MAX, lineageId } from './config';
import { lineageFail } from './eligibility';
import type { SuccessionMode } from './succession';

export function lineageControlRevisions(fromRevision: number, toRevision: number) {
  if (![fromRevision, toRevision].every((value) => Number.isInteger(value) && value >= 0 && value < LINEAGE_MAX - 1))
    return lineageFail('LIMIT', '계승 예약 변경 번호 한도에 닿았습니다.');
  return { ok: true as const, fromRevision: fromRevision + 1, toRevision: Math.max(fromRevision, toRevision) + 1 };
}

export function recordedLineageSuccession(input: RecordedInput) {
  if (
    input.kind !== 'lineage.act' ||
    input.status !== 'APPLIED' ||
    !input.result ||
    typeof input.result !== 'object' ||
    Array.isArray(input.result) ||
    !('action' in input.result) ||
    input.result.action !== 'succession.confirm'
  )
    return undefined;
  if (!('successorId' in input.result)) throw new Error('계승 결과의 후계자 번호가 없습니다.');
  return { fromId: lineageId.parse(input.generalId), toId: lineageId.parse(input.result.successorId) };
}

// 개인 칸은 항상 새로 시작한다. 새 revision은 전임자·후계자 양쪽의 옛 양식보다 커야 한다.
export function resetLineageControl(
  before: ReplayState,
  after: ReplayState,
  fromId: number,
  toId: number,
  mode: SuccessionMode,
  tick: number,
): ReplayState {
  const revisions = lineageControlRevisions(after.revisions[fromId]!, after.revisions[toId]!);
  if (!revisions.ok) throw new Error(revisions.message);
  const next: ReplayState = {
    ...after,
    turns: { ...after.turns, [toId]: after.policy ? emptyQueue() : emptyTurns() },
    revisions: { ...after.revisions, [fromId]: revisions.fromRevision, [toId]: revisions.toRevision },
  };
  if (after.policy) {
    const policy = structuredClone(after.policy);
    policy.policies[fromId] = 'none';
    policy.policies[toId] = 'none';
    delete policy.lastActiveTicks[fromId];
    if (next.state.generals[toId]!.userId !== null) policy.lastActiveTicks[toId] = tick;
    else delete policy.lastActiveTicks[toId];
    next.policy = policy;
  }
  if (mode === 'HUMAN') {
    if (before.residenceAnchors === undefined) throw new Error('계승 전 사람의 거주 앵커가 없습니다.');
    next.residenceAnchors = updateResidenceAnchors({
      before: before.state,
      after: next.state,
      anchors: before.residenceAnchors,
      tick,
      createdHumanId: null,
      succession: { fromId, toId },
    });
  }
  return next;
}
