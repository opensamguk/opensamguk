import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Context } from '../context';
import { worldInput } from '../game/queries';
import { listTreaties, quoteTreaty } from '../game/treatyReads';
import {
  readTreatyRequest,
  requireLiveSession,
  submitTreatyRequest,
  type TreatyRequestKind,
  type TreatyRequestState,
} from '../game/treatyRequests';
import { recordsInput } from '../queries';
import { protectedProcedure, router } from '../trpc';

const listInput = worldInput.extend({ cursor: recordsInput.shape.cursor });
const quoteInput = worldInput.extend({ toNationId: z.unknown(), clauses: z.unknown() });
const proposeInput = worldInput.extend({ requestId: z.uuid(), toNationId: z.unknown(), clauses: z.unknown() });
const respondInput = worldInput.extend({ requestId: z.uuid(), treatyId: z.unknown(), accept: z.unknown() });
const requestInput = worldInput.extend({ requestId: z.uuid() });
type ActorContext = Pick<Context, 'db' | 'sessionId' | 'now'> & { user: { id: string } };

function identity(ctx: ActorContext, started: number) {
  return { userId: ctx.user.id, sessionId: ctx.sessionId ?? '', at: new Date(ctx.now + performance.now() - started) };
}

async function submitAndWait(
  ctx: ActorContext,
  input: { worldId: string; requestId: string; kind: TreatyRequestKind; payload: unknown },
): Promise<TreatyRequestState> {
  const started = performance.now();
  await ctx.db.$transaction((tx) => submitTreatyRequest(tx, { ...input, ...identity(ctx, started) }), {
    isolationLevel: 'ReadCommitted',
  });
  const deadline = performance.now() + 5000;
  while (true) {
    const result = await ctx.db.$transaction(
      (tx) => readTreatyRequest(tx, { worldId: input.worldId, requestId: input.requestId, ...identity(ctx, started) }),
      { isolationLevel: 'RepeatableRead' },
    );
    const remaining = deadline - performance.now();
    if (result.status !== 'pending' || remaining <= 0) return result;
    await delay(Math.min(100, remaining));
  }
}

export const treatyRouter = router({
  list: protectedProcedure.input(listInput).query(({ ctx, input }) => {
    const started = performance.now();
    return ctx.db.$transaction(
      async (tx) => {
        await requireLiveSession(tx, identity(ctx, started));
        return listTreaties(tx, { ...input, cursor: input.cursor, userId: ctx.user.id });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }),
  quote: protectedProcedure.input(quoteInput).query(({ ctx, input }) => {
    const started = performance.now();
    return ctx.db.$transaction(
      async (tx) => {
        await requireLiveSession(tx, identity(ctx, started));
        return quoteTreaty(tx, {
          worldId: input.worldId,
          userId: ctx.user.id,
          payload: { toNationId: input.toNationId, clauses: input.clauses },
        });
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }),
  propose: protectedProcedure.input(proposeInput).mutation(({ ctx, input }) =>
    submitAndWait(ctx, {
      worldId: input.worldId,
      requestId: input.requestId,
      kind: 'treaty.propose',
      payload: { toNationId: input.toNationId, clauses: input.clauses },
    }),
  ),
  respond: protectedProcedure.input(respondInput).mutation(({ ctx, input }) =>
    submitAndWait(ctx, {
      worldId: input.worldId,
      requestId: input.requestId,
      kind: 'treaty.respond',
      payload: { treatyId: input.treatyId, accept: input.accept },
    }),
  ),
  request: protectedProcedure.input(requestInput).query(({ ctx, input }) => {
    const started = performance.now();
    return ctx.db.$transaction((tx) => readTreatyRequest(tx, { ...input, ...identity(ctx, started) }), {
      isolationLevel: 'RepeatableRead',
    });
  }),
});
