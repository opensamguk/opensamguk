import { setTimeout as delay } from 'node:timers/promises';
import type { Prisma } from '@opensamguk/db';
import type { PersonnelInputKind } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import type { Context } from '../context';
import { requireWorld } from './queries';
import { requirePersonnelSession, requirePersonnelWorld, submitPersonnelRequest } from './personnelAdmission';
import {
  readPersonnelRequest,
  type PersonnelReady,
  type RequestState,
  type AppointResult,
  type RespondResult,
} from './personnelRequests';

export type PersonnelActorContext = Pick<Context, 'db' | 'sessionId' | 'now'> & { user: { id: string } };
export function personnelIdentity(ctx: PersonnelActorContext, started: number) {
  return { userId: ctx.user.id, sessionId: ctx.sessionId ?? '', at: new Date(ctx.now + performance.now() - started) };
}
export async function withPersonnel<T>(
  ctx: PersonnelActorContext,
  worldId: string,
  read: (tx: Prisma.TransactionClient, ready: PersonnelReady) => Promise<T>,
  started = performance.now(),
): Promise<T> {
  return ctx.db.$transaction(
    async (tx) => {
      await requirePersonnelSession(tx, personnelIdentity(ctx, started));
      const ready = requirePersonnelWorld(await requireWorld(tx, worldId));
      return read(tx, ready);
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
type Submission = { worldId: string; requestId: string; payload: unknown };
type SubmissionResult<R> = Exclude<RequestState<R>, { status: 'rejected' }>;
export function submitAndWaitPersonnel(
  ctx: PersonnelActorContext,
  input: Submission & { kind: 'personnel.appoint' | 'personnel.dismiss' },
): Promise<SubmissionResult<AppointResult>>;
export function submitAndWaitPersonnel(
  ctx: PersonnelActorContext,
  input: Submission & { kind: 'offer.respond' },
): Promise<SubmissionResult<RespondResult>>;
export async function submitAndWaitPersonnel(
  ctx: PersonnelActorContext,
  input: { worldId: string; requestId: string; kind: PersonnelInputKind; payload: unknown },
) {
  const started = performance.now();
  await ctx.db.$transaction((tx) => submitPersonnelRequest(tx, { ...input, ...personnelIdentity(ctx, started) }));
  const deadline = performance.now() + 5000;
  while (true) {
    const record = await withPersonnel(
      ctx,
      input.worldId,
      (tx, ready) =>
        readPersonnelRequest(tx, ready, {
          worldId: input.worldId,
          userId: ctx.user.id,
          requestId: input.requestId,
        }),
      started,
    );
    if (record.kind !== input.kind)
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '인사 요청 종류가 다릅니다.' });
    if (record.state.status === 'rejected')
      throw new TRPCError({
        code:
          record.state.code === 'OFFER_CLOSED'
            ? 'CONFLICT'
            : ['NOT_RULER', 'NOT_NATION', 'ACTOR_INACTIVE', 'NO_GENERAL'].includes(record.state.code)
              ? 'FORBIDDEN'
              : record.state.code === 'WORLD_CLOSED'
                ? 'PRECONDITION_FAILED'
                : 'BAD_REQUEST',
        message: record.state.message,
      });
    const remaining = deadline - performance.now();
    if (record.state.status !== 'pending' || remaining <= 0) return record.state;
    await delay(Math.min(100, remaining));
  }
}
