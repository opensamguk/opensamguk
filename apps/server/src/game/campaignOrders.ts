import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  applyCampaignOrder,
  campaignOrderInputSchema,
  campaignOrderResultSchema,
  campaignNpcSuperior,
  canIssueCampaignOrder,
  checkReplayOrigin,
  unitSetSchema,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import type { Context } from '../context';
import { activeSanctionWhere } from '../auth/sanction';
import { missingConsents } from '../legal/policy';
import { databaseTime } from '../messaging';
import { PublicReasonError } from '../trpc';
import { requireGeneral, requireWorld, readView, requireRuleFeature } from './queries';
import { worldResolver } from './resolver';
import { readSlots } from './slots';

type OrderContext = Context & { user: NonNullable<Context['user']> };
type OrderReadContext = Pick<
  Context,
  'db' | 'sessionId' | 'emailVerificationRequired' | 'legalPolicy' | 'legalPolicyRequired'
> & { user: { id: string } };
export async function requireCampaignOrderAccess(tx: Prisma.TransactionClient, ctx: OrderReadContext, worldId: string) {
  if (!ctx.sessionId) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${ctx.user.id} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${ctx.sessionId} AND "userId"=${ctx.user.id} FOR SHARE`;
  const now = await databaseTime(tx);
  const session = await tx.session.findFirst({
    where: { id: ctx.sessionId, userId: ctx.user.id, expiresAt: { gt: now } },
    select: {
      user: { select: { status: true, emailVerifiedAt: true, consents: { select: { docType: true, version: true } } } },
    },
  });
  if (!session || session.user.status !== 'ACTIVE')
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (
    await tx.sanction.findFirst({
      where: {
        userId: ctx.user.id,
        ...activeSanctionWhere(now.getTime()),
        AND: [{ OR: [{ worldId: null }, { worldId }] }],
      },
      select: { id: true },
    })
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: '이 월드의 이용이 제한됐습니다.' });
  if (ctx.legalPolicyRequired && !ctx.legalPolicy)
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '약관을 준비하고 있습니다.' });
  if (ctx.emailVerificationRequired && session.user.emailVerifiedAt === null)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '이메일 인증이 필요합니다.',
      cause: new PublicReasonError('EMAIL_NOT_VERIFIED'),
    });
  if (missingConsents(ctx.legalPolicy, session.user.consents).length)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '약관 동의가 필요합니다.',
      cause: new PublicReasonError('CONSENT_REQUIRED'),
    });
}
function ready(world: Awaited<ReturnType<typeof requireWorld>>) {
  requireRuleFeature(world, 'campaign-v1');
  if (world.replayFormat !== 3)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '휘하 지시를 사용할 수 없습니다.' });
  checkReplayOrigin(world.replayOrigin);
  if (
    world.replayOrigin.version !== 3 ||
    !isDeepStrictEqual(world.replayOrigin.initial.ruleFeatures ?? [], world.ruleFeatures) ||
    !isDeepStrictEqual(world.unitSet, world.replayOrigin.initial.unitSet)
  )
    throw new Error('휘하 지시의 원생성 기능·병종 사본이 다릅니다.');
}
export async function readCampaignOrders(ctx: OrderContext, worldId: string) {
  return ctx.db.$transaction(
    async (tx) => {
      const world = await requireWorld(tx, worldId);
      ready(world);
      await requireCampaignOrderAccess(tx, ctx, worldId);
      const actor = await requireGeneral(tx, worldId, ctx.user.id),
        view = await readView(tx, worldId);
      const superior = campaignNpcSuperior(view, actor.id);
      const slots = await readSlots(tx, worldId, actor.id);
      return {
        userId: ctx.user.id,
        actorId: actor.id,
        revision: view.campaign!.revision,
        status: world.status,
        recipients: Object.values(view.generals)
          .filter((general) => canIssueCampaignOrder(view, actor.id, general.id))
          .sort((a, b) => a.id - b.id)
          .map(({ id, name, userId }) => ({ id, name, isHuman: userId !== null })),
        npcSuperior: superior === null ? null : { id: superior, name: view.generals[superior]!.name },
        orders: (view.campaign!.orders?.items ?? [])
          .filter((order) => order.issuerId === actor.id || order.recipientId === actor.id)
          .map((order) => ({
            id: order.id,
            issuerId: order.issuerId,
            issuerName: view.generals[order.issuerId]!.name,
            recipientId: order.recipientId,
            recipientName: view.generals[order.recipientId]!.name,
            command: order.command,
            status: order.status,
            createdTick: order.createdTick,
            ...(order.result === null ? {} : { result: order.result }),
          })),
        next: { turnRevision: actor.turnRevision, firstSlot: slots[0]! },
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function submitCampaignOrder(
  ctx: OrderContext,
  input: { worldId: string; requestId: string; expectedUserId: string; payload: unknown },
) {
  return ctx.db.$transaction(async (tx) => {
    const world = await requireWorld(tx, input.worldId, true);
    ready(world);
    await requireCampaignOrderAccess(tx, ctx, world.id);
    if (ctx.user.id !== input.expectedUserId)
      throw new TRPCError({ code: 'CONFLICT', message: '로그인한 계정이 바뀌었습니다.' });
    const payload = campaignOrderInputSchema.parse(input.payload),
      idempotencyKey = `campaign:${input.requestId}`;
    const prior = await tx.inputEvent.findUnique({
      where: { worldId_userId_idempotencyKey: { worldId: world.id, userId: ctx.user.id, idempotencyKey } },
    });
    if (prior) {
      if (prior.kind !== 'campaign.order' || !isDeepStrictEqual(prior.payload, payload))
        throw new TRPCError({ code: 'CONFLICT', message: '같은 요청 번호로 다른 내용을 보냈습니다.' });
      return {
        requestId: input.requestId,
        userId: ctx.user.id,
        status:
          prior.status === 'PENDING'
            ? ('pending' as const)
            : prior.status === 'APPLIED'
              ? ('applied' as const)
              : ('rejected' as const),
        ...(prior.status === 'APPLIED' ? { result: campaignOrderResultSchema.parse(prior.result) } : {}),
      };
    }
    if (world.status !== 'RUNNING')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
    const actor = await requireGeneral(tx, world.id, ctx.user.id, true),
      view = await readView(tx, world.id);
    const recipientId = payload.type === 'issue' ? payload.recipientId : actor.id;
    const recipient = await tx.general.findUnique({ where: { worldId_id: { worldId: world.id, id: recipientId } } });
    if (!recipient) throw new TRPCError({ code: 'NOT_FOUND', message: '수신 장수가 없습니다.' });
    const slots = await readSlots(tx, world.id, recipientId);
    const assessment = applyCampaignOrder(view, payload, actor.id, {
      tick: world.clockTick,
      userId: ctx.user.id,
      userActive: true,
      turns: { [recipientId]: slots },
      revisions: { [recipientId]: recipient.turnRevision },
      unitSet: unitSetSchema.parse(world.unitSet),
      resolver: worldResolver(world).resolver,
    });
    if (!assessment.ok)
      throw new TRPCError({
        code: assessment.code === 'STALE' || assessment.code === 'PENDING' ? 'CONFLICT' : 'BAD_REQUEST',
        message: assessment.message,
      });
    if (
      await tx.inputEvent.findFirst({
        where: { worldId: world.id, userId: ctx.user.id, kind: 'campaign.order', status: 'PENDING' },
        select: { id: true },
      })
    )
      throw new TRPCError({ code: 'CONFLICT', message: '요청을 처리하는 중입니다.' });
    await tx.inputEvent.create({
      data: {
        worldId: world.id,
        userId: ctx.user.id,
        generalId: actor.id,
        kind: 'campaign.order',
        idempotencyKey,
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
        sequence: null,
      },
    });
    await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
      VALUES (${world.id},${ctx.user.id},${actor.id},'general.active',${`general.active:campaign:${input.requestId}`},'{}'::jsonb,'PENDING')
      ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
    return { requestId: input.requestId, userId: ctx.user.id, status: 'pending' as const };
  });
}
