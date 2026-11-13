import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Prisma } from '@opensamguk/db';
import type { Context } from '../context';
import { databaseTime } from '../messaging';
import { requireCurrentAdmin } from './access';

const revision = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const operation = z.enum(['DEPLOY', 'ROLLBACK']);
const candidates = z.array(z.strictObject({ revision, manifestSha256: digest, operation })).max(32);
const controlId = 'production';
const liveForMs = 30_000;

export const releaseRequestInput = z.strictObject({
  expectedUserId: z.uuid(),
  id: z.uuid(),
  operation,
  expectedRevision: revision,
  targetRevision: revision,
  manifestSha256: digest,
  reason: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) =>
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    ),
});

export const releaseStatusInput = z.strictObject({ expectedUserId: z.uuid() });

export async function getReleaseStatus(ctx: Context, expectedUserId: string) {
  if (ctx.user?.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
  return ctx.db.$transaction(async (tx) => {
    await requireCurrentAdmin(tx, ctx, false);
    const control = await currentControl(tx);
    const requests = await tx.releaseRequest.findMany({
      orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
      take: 15,
      select: {
        id: true,
        operation: true,
        expectedRevision: true,
        targetRevision: true,
        status: true,
        requestedAt: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    return { control, requests };
  });
}

async function currentControl(tx: Prisma.TransactionClient) {
  const record = await tx.releaseControl.findUnique({ where: { id: controlId } });
  const parsed = candidates.safeParse(record?.candidates);
  if (!record || !parsed.success || !revision.safeParse(record.currentRevision).success) return null;
  const now = await databaseTime(tx);
  if (now.getTime() - record.seenAt.getTime() > liveForMs || record.seenAt > now) return null;
  return { currentRevision: record.currentRevision, candidates: parsed.data };
}

export async function requestRelease(ctx: Context, input: z.infer<typeof releaseRequestInput>) {
  if (ctx.user?.id !== input.expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
  return ctx.db.$transaction(async (tx) => {
    const actorUserId = await requireCurrentAdmin(tx, ctx, true);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('release:control', 0))`;
    const prior = await tx.releaseRequest.findUnique({ where: { id: input.id } });
    if (prior) {
      const audit = await tx.auditLog.findFirst({ where: { action: 'release.request', targetId: prior.id } });
      if (
        prior.actorUserId !== actorUserId ||
        prior.operation !== input.operation ||
        prior.expectedRevision !== input.expectedRevision ||
        prior.targetRevision !== input.targetRevision ||
        prior.manifestSha256 !== input.manifestSha256 ||
        audit?.reason !== input.reason
      )
        throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
      return { id: prior.id, status: prior.status };
    }
    const control = await currentControl(tx);
    if (!control)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '배포 호스트에 연결되어 있지 않습니다.' });
    if (
      control.currentRevision !== input.expectedRevision ||
      input.targetRevision === input.expectedRevision ||
      !control.candidates.some(
        (candidate) =>
          candidate.revision === input.targetRevision &&
          candidate.operation === input.operation &&
          candidate.manifestSha256 === input.manifestSha256,
      )
    )
      throw new TRPCError({ code: 'CONFLICT', message: '현재 버전 또는 승인 목록이 바뀌었습니다. 새로 확인하세요.' });
    const active = await tx.releaseRequest.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING', 'NEEDS_OWNER'] } },
      select: { id: true },
    });
    if (active) throw new TRPCError({ code: 'CONFLICT', message: '진행 중이거나 점검이 필요한 배포 요청이 있습니다.' });
    const { expectedRevision, targetRevision, manifestSha256, operation } = input;
    const request = await tx.releaseRequest.create({
      data: { id: input.id, actorUserId, expectedRevision, targetRevision, manifestSha256, operation },
    });
    await tx.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId,
        action: 'release.request',
        targetType: 'Release',
        targetId: request.id,
        reason: input.reason,
        payload: { expectedRevision, targetRevision, manifestSha256, operation },
      },
    });
    return { id: request.id, status: request.status };
  });
}
