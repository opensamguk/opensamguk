import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, verifiedProcedure, router } from '../trpc';
import {
  changeNotificationSettings,
  getNotificationSettings,
  notificationEvents,
  setDiscord,
} from '../notifications/settings';

const generation = z.number().int().min(0).max(2147483647);
const events = z
  .array(z.enum(notificationEvents))
  .max(4)
  .refine((values) => new Set(values).size === values.length);
const identity = (ctx: { user: { id: string }; sessionId: string | null }) => ({
  userId: ctx.user.id,
  sessionId: ctx.sessionId,
});
const notificationMutation = verifiedProcedure.use(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof z.ZodError)
    throw new TRPCError({ code: 'BAD_REQUEST', message: '알림 입력을 확인하세요.' });
  return result;
});
export const notificationRouter = router({
  get: protectedProcedure.input(z.void()).query(({ ctx }) => getNotificationSettings(ctx.db, identity(ctx))),
  setDiscord: notificationMutation
    .input(z.strictObject({ url: z.string(), events, generation }, { error: '알림 입력을 확인하세요.' }))
    .mutation(({ ctx, input }) => {
      const decision = ctx.rateLimiter.consume([
        { namespace: 'notification.register.user', key: ctx.user.id, limit: 5, windowMs: 60_000 },
        { namespace: 'notification.register.ip', key: ctx.ip, limit: 15, windowMs: 60_000 },
      ]);
      if (!decision.allowed) {
        ctx.reply.header('Retry-After', String(decision.retryAfterSeconds));
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: '잠시 뒤 다시 요청하세요.' });
      }
      return setDiscord(ctx.db, identity(ctx), input, ctx.notificationTransport);
    }),
  setEvents: notificationMutation
    .input(z.strictObject({ events, generation }, { error: '알림 입력을 확인하세요.' }))
    .mutation(({ ctx, input }) => changeNotificationSettings(ctx.db, identity(ctx), input)),
  removeDiscord: notificationMutation
    .input(z.strictObject({ generation }, { error: '알림 입력을 확인하세요.' }))
    .mutation(({ ctx, input }) => changeNotificationSettings(ctx.db, identity(ctx), input)),
});
