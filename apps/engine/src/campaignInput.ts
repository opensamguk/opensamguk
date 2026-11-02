import type { Prisma } from '@opensamguk/db';
import {
  applyCampaignRelationship,
  applyCampaignUnitInput,
  applyCampaignOrder,
  resolverForRuleFeatures,
  unitSetSchema,
  applyRecordedInput,
  type RecordedInput,
  type ReplayState,
} from '@opensamguk/rules';
import type { EngineWorld, QueuedInputHandler } from './features';
import { loadReplayState } from './monthly';
import { persistEffects } from './persist';
import { databaseNow } from './lease';

export async function processCampaignQueuedInput(
  tx: Parameters<QueuedInputHandler>[0],
  world: Parameters<QueuedInputHandler>[1],
  event: Parameters<QueuedInputHandler>[2],
  { tick, sequence }: Parameters<QueuedInputHandler>[3],
): ReturnType<QueuedInputHandler> {
  const reject = (code: string, message: string) => ({ status: 'REJECTED' as const, result: { code, message } });
  if (world.status === 'ENDED') return reject('WORLD_CLOSED', '종료된 월드입니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${event.userId} FOR SHARE`;
  const user = await tx.user.findUnique({ where: { id: event.userId } });
  if (!user || user.status !== 'ACTIVE') return reject('ACTOR_INACTIVE', '활성 계정이 아닙니다.');
  if (event.kind === 'campaign.order') {
    if (world.status !== 'RUNNING') return reject('WORLD_CLOSED', '실행 중인 월드가 아닙니다.');
    const now = await databaseNow(tx);
    if (
      await tx.sanction.findFirst({
        where: {
          userId: event.userId,
          liftedAt: null,
          AND: [
            { OR: [{ worldId: null }, { worldId: world.id }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
        select: { id: true },
      })
    )
      return reject('ACTOR_SANCTIONED', '이 월드의 이용이 제한됐습니다.');
  }
  if (event.generalId === null) return reject('NO_GENERAL', '장수가 없습니다.');
  await tx.$queryRaw`SELECT id FROM "General" WHERE "worldId" = ${world.id} AND id = ${event.generalId} FOR UPDATE`;
  const before = await loadReplayState(tx, world.id);
  const context = { tick, userId: event.userId, userActive: true };
  const outcome =
    event.kind === 'campaign.relationship'
      ? applyCampaignRelationship(before.state, event.payload, event.generalId, before.state.campaign, context)
      : event.kind === 'campaign.unit'
        ? applyCampaignUnitInput(before.state, event.payload, event.generalId, before.state.campaign, {
            ...context,
            armyTypes: before.campaignArmyTypes!,
          })
        : event.kind === 'campaign.order'
          ? applyCampaignOrder(before.state, event.payload, event.generalId, {
              ...context,
              turns: before.turns,
              revisions: before.revisions,
              resolver: resolverForRuleFeatures(before.state)!,
              unitSet: unitSetSchema.parse(world.unitSet),
            })
          : null;
  if (!outcome) throw new Error('휘하·부곡 입력 종류를 확인하세요.');
  if (!outcome.ok) return reject(outcome.code, outcome.message);
  await persistEffects(
    tx,
    world.id,
    outcome.state,
    [{ kind: 'world', state: outcome.state }],
    { tick, sequence },
    before.state,
  );
  return { status: 'APPLIED', result: { ...outcome.result, tick } as Prisma.InputJsonValue };
}

// general.create는 General을 먼저 쓴다. 뒤의 인사 후처리가 loadWorld하기 전에 입력 출처도 같은 트랜잭션에 쓴다.
export async function persistForeignCampaignInput(
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  before: ReplayState,
  input: RecordedInput,
) {
  const next = applyRecordedInput(before, input);
  await persistEffects(
    tx,
    world.id,
    next.state,
    [{ kind: 'world', state: next.state }],
    { tick: input.tick!, sequence: input.sequence },
    before.state,
  );
}
