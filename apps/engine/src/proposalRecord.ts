import { proposalRecordPayload, proposalReward } from '@opensamguk/rules';
import type { QueuedInputHandler } from './features';
import { appendNationHistory } from './commandPersistence';

// 순환 import 중 등록표가 읽을 수 있도록 함수 선언으로 둔다.
export function processProposalRecord(...args: Parameters<QueuedInputHandler>): ReturnType<QueuedInputHandler> {
  return handleProposalRecord(...args);
}
const handleProposalRecord: QueuedInputHandler = async (tx, world, event, { tick, sequence }) => {
  const payload = proposalRecordPayload.parse(event.payload);
  const dedication = proposalReward(payload);
  if (dedication)
    await tx.general.update({
      where: { worldId_id: { worldId: world.id, id: payload.proposerId } },
      data: { dedication: { increment: dedication } },
    });
  await tx.generalLog.create({
    data: {
      worldId: world.id,
      generalId: payload.proposerId,
      tick,
      sequence,
      commandKey: 'proposal.record',
      kind: 'proposal',
      text: payload.text,
    },
  });
  await appendNationHistory(tx, world.id, tick, payload.nationId, payload.text, 'proposal');
  return { status: 'APPLIED', result: { dedication } };
};
