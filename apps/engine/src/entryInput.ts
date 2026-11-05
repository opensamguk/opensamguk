import type { Prisma } from '@opensamguk/db';
import {
  POSSESSION_KIND,
  possessionPayloadSchema,
  decidePossession,
  applyPossessionInput,
  effectiveWorldOptions,
  parsePreset,
  type RecordedInput,
} from '@opensamguk/rules';
import type { QueuedInputHandler } from './features';
import { databaseNow } from './lease';
import { loadReplayState } from './monthly';

export const processPossession: QueuedInputHandler = async (tx, world, event, { tick, sequence }) => {
  const payload = possessionPayloadSchema.parse(event.payload);
  if (event.kind !== POSSESSION_KIND || event.generalId !== null || payload.userId !== event.userId)
    throw Error('대기 중인 장수 맡기 요청의 출처가 다릅니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true } });
  const now = await databaseNow(tx);
  const sanction = await tx.sanction.findFirst({
    where: {
      userId: event.userId,
      liftedAt: null,
      AND: [
        { OR: [{ worldId: null }, { worldId: world.id }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    select: { id: true },
  });
  const before = await loadReplayState(tx, world.id);
  const outcome = decidePossession(before, payload, {
    tick,
    status: world.status,
    npcPlay:
      effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions).entry
        .npcPlay === 'on',
    userActive: user?.status === 'ACTIVE',
    sanctioned: sanction !== null,
    replayFormat: world.replayFormat,
  });
  if (outcome.status === 'REJECTED') return outcome;
  const input: RecordedInput = {
    sequence,
    tick,
    generalId: payload.generalId,
    kind: event.kind,
    status: 'APPLIED',
    payload,
    result: outcome.result,
  };
  applyPossessionInput(before, input);
  const saved = await tx.general.updateMany({
    where: {
      worldId: world.id,
      id: payload.generalId,
      userId: null,
      turnRevision: outcome.result.revision - 1,
    },
    data: {
      userId: event.userId,
      turnRevision: outcome.result.revision,
      ...(before.policy ? { lastActiveTick: tick, lastActiveAt: event.createdAt } : {}),
    },
  });
  if (saved.count !== 1) throw Error('장수의 소유권이나 예턴 revision이 바뀌었습니다.');
  if (outcome.result.rulerNationId !== null)
    await tx.nation.update({
      where: { worldId_id: { worldId: world.id, id: outcome.result.rulerNationId } },
      data: { isNpc: false },
    });
  return { status: 'APPLIED', generalId: payload.generalId, result: outcome.result as Prisma.InputJsonValue };
};

export async function appendPossessionLog(
  tx: Prisma.TransactionClient,
  worldId: string,
  generalId: number,
  tick: number,
  sequence: number,
) {
  const last = await tx.generalLog.findFirst({
    where: { worldId, generalId, sequence },
    orderBy: { ordinal: 'desc' },
    select: { ordinal: true },
  });
  await tx.generalLog.create({
    data: {
      worldId,
      generalId,
      tick,
      sequence,
      ordinal: (last?.ordinal ?? -1) + 1,
      commandKey: POSSESSION_KIND,
      kind: 'possess',
      text: '이 장수를 맡았습니다.',
    },
  });
}
