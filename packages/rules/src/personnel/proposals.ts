import { z } from 'zod';
import { canExecuteNationCommand } from './permissions';
import { canExecuteCityNationCommand } from '../cityResources/commands';
import { canExecuteResearchNationCommand } from '../nationResearch/commands';
import type { ReplayState, RecordedInput } from '../replay';
import type { WorldView } from '../model/world';

export const PROPOSAL_EXPIRY_TICKS = 12;
export const PROPOSAL_OPEN_LIMIT = 3;
export const PROPOSAL_DEDICATION = 10;
export function invalidatedProposalProposers(before: WorldView, next: WorldView) {
  return Object.values(before.generals)
    .filter((old) => {
      const current = next.generals[old.id];
      return (
        !current ||
        old.nationId !== current.nationId ||
        old.officerLevel !== current.officerLevel ||
        old.removedAt !== current.removedAt
      );
    })
    .map((general) => general.id);
}
export const proposalStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']);
export function canApproveProposal(
  world: Parameters<typeof canExecuteCityNationCommand>[0],
  level: number,
  key: string,
) {
  return (
    canExecuteNationCommand(level, key) ||
    canExecuteCityNationCommand(world, level, key) ||
    canExecuteResearchNationCommand(world, level, key)
  );
}
export function proposalExpired(
  proposal: { nationId: number; proposerLevel: number; expiresTick: number },
  proposer: { nationId: number | null; officerLevel: number; removedAt: unknown } | undefined,
  tick: number,
) {
  return (
    tick >= proposal.expiresTick ||
    !proposer ||
    proposer.removedAt !== null ||
    proposer.nationId !== proposal.nationId ||
    proposer.officerLevel !== proposal.proposerLevel
  );
}
export const proposalRecordPayload = z.strictObject({
  proposalId: z.uuid(),
  proposerId: z.number().int().positive(),
  nationId: z.number().int().positive(),
  action: z.enum(['create', 'approve', 'reject', 'cancel']),
  text: z.string().min(1).max(1000),
});
export function proposalReward(payload: z.infer<typeof proposalRecordPayload>) {
  return payload.action === 'approve' ? PROPOSAL_DEDICATION : 0;
}
export function applyProposalRecord(replay: ReplayState, input: RecordedInput): ReplayState {
  const payload = proposalRecordPayload.parse(input.payload);
  if (input.status !== 'APPLIED') throw new Error('제안 기록 상태가 다릅니다.');
  const result = z.strictObject({ dedication: z.number().int().nonnegative() }).parse(input.result);
  if (result.dedication !== proposalReward(payload)) throw new Error('제안 공헌 기록이 다릅니다.');
  if (!result.dedication) return replay;
  const state = structuredClone(replay.state);
  const proposer = state.generals[payload.proposerId];
  if (!proposer) throw new Error('제안 장수가 없습니다.');
  proposer.dedication += result.dedication;
  return { ...replay, state };
}
