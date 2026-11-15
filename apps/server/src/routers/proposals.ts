import { z } from 'zod';
import { activeSanctionWhere } from '../auth/sanction';
import { protectedProcedure, router, worldVerifiedProcedure } from '../trpc';
import { worldInput } from '../game/queries';
import { proposalStatus } from '@opensamguk/rules';
import {
  createProposal,
  listProposals,
  listProposableCommands,
  readProposalHistory,
  respondProposal,
} from '../game/proposals';
import { requirePersonnelSession } from '../game/personnelAdmission';
import { personnelIdentity, withPersonnel, type PersonnelActorContext } from '../game/personnelApi';
import { TRPCError } from '@trpc/server';

const slot = z.number().int().min(0).max(11).optional();
const note = z.string().max(200).optional();
const identity = z.strictObject({ proposalId: z.uuid() });
async function respond(ctx: PersonnelActorContext, input: Parameters<typeof respondProposal>[2]) {
  const started = performance.now();
  return ctx.db.$transaction(async (tx) => {
    await requirePersonnelSession(tx, personnelIdentity(ctx, started));
    const row = await tx.commandProposal.findUnique({ where: { id: input.proposalId } });
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: '제안이 없습니다.' });
    if (
      await tx.sanction.findFirst({
        where: { userId: ctx.user.id, worldId: row.worldId, ...activeSanctionWhere(ctx.now) },
      })
    )
      throw new TRPCError({ code: 'FORBIDDEN', message: '이 월드의 이용이 제한됐습니다.' });
    return respondProposal(tx, ctx.user.id, input);
  });
}
export const proposalsRouter = router({
  history: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx) => readProposalHistory(tx, input.worldId, ctx.user.id)),
    ),
  commands: protectedProcedure
    .input(worldInput)
    .query(({ ctx, input }) =>
      withPersonnel(ctx, input.worldId, (tx) => listProposableCommands(tx, input.worldId, ctx.user.id)),
    ),
  create: worldVerifiedProcedure
    .input(worldInput.extend({ commandKey: z.string().min(1).max(100), args: z.unknown().optional(), slot, note }))
    .mutation(({ ctx, input }) => {
      const started = performance.now();
      return ctx.db.$transaction(async (tx) => {
        await requirePersonnelSession(tx, personnelIdentity(ctx, started));
        return createProposal(tx, ctx.user.id, input);
      });
    }),
  list: protectedProcedure
    .input(worldInput.extend({ box: z.enum(['received', 'sent']), status: proposalStatus.optional() }))
    .query(({ ctx, input }) => {
      const started = performance.now();
      return ctx.db.$transaction(
        async (tx) => {
          await requirePersonnelSession(tx, personnelIdentity(ctx, started));
          return listProposals(tx, ctx.user.id, input);
        },
        { isolationLevel: 'RepeatableRead' },
      );
    }),
  respond: worldVerifiedProcedure
    .input(identity.extend({ decision: z.enum(['approve', 'reject']), slot, reason: note }))
    .mutation(({ ctx, input }) => respond(ctx, input)),
  cancel: worldVerifiedProcedure
    .input(identity)
    .mutation(({ ctx, input }) => respond(ctx, { ...input, decision: 'cancel' })),
});
