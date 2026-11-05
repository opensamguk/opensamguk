import { TRPCError } from '@trpc/server';
import { hashState } from '@opensamguk/shared/node';
import { z } from 'zod';
import {
  adminSettingSchema,
  adminSettingPayloadSchema,
  adminSettingAppliedSchema,
  adminSettingRejectedSchema,
  isAdminSettingKind,
  effectiveWorldOptions,
  parsePreset,
} from '@opensamguk/rules';
import type { Context } from '../context';
import { verifiedProcedure } from '../trpc';
import { requireAdminRole } from './role';
import { requireCurrentAdmin } from './access';

export const requestSettingInput = z.strictObject({
  expectedUserId: z.uuid(),
  worldId: z.uuid(),
  idempotencyKey: z.uuid(),
  reason: adminSettingPayloadSchema.shape.reason,
  setting: adminSettingSchema,
});
export const settingRequestInput = requestSettingInput.pick({
  expectedUserId: true,
  worldId: true,
  idempotencyKey: true,
});
export const worldSettingsInput = z.strictObject({ worldId: z.uuid() });
export const settingRequestProcedure = verifiedProcedure.use(async ({ ctx, next, getRawInput }) => {
  async function rejected(error: unknown) {
    const parsed = requestSettingInput.safeParse(await getRawInput().catch(() => undefined));
    await ctx.db.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: ctx.user.id,
        action: 'world.setting.request.rejected',
        targetType: 'World',
        targetId: parsed.success ? parsed.data.worldId : null,
        worldId: parsed.success ? parsed.data.worldId : null,
        reason: parsed.success ? parsed.data.reason : null,
        payload: { code: error instanceof TRPCError ? error.code : 'INTERNAL_SERVER_ERROR' },
      },
    });
  }
  try {
    await requireAdminRole(ctx.db, ctx.user.id);
  } catch (error) {
    await rejected(error);
    throw error;
  }
  const result = await next();
  if (!result.ok) await rejected(result.error);
  return result;
});
function expectedActor(ctx: Context, expectedUserId: string) {
  if (!ctx.user || ctx.user.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}
function publicError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '월드 설정 요청을 처리하지 못했습니다.' });
}
function response(event: {
  id: bigint;
  kind: string;
  status: string;
  sequence: number | null;
  tick: number | null;
  payload: unknown;
  result: unknown;
}) {
  const payload = adminSettingPayloadSchema.parse(event.payload);
  if (!isAdminSettingKind(event.kind) || event.kind !== payload.setting.kind)
    throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
  return {
    requestId: String(event.id),
    kind: event.kind,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
    result:
      event.status === 'APPLIED'
        ? adminSettingAppliedSchema(payload.setting).parse(event.result)
        : event.status === 'REJECTED'
          ? adminSettingRejectedSchema.parse(event.result)
          : null,
  };
}
export async function requestWorldSetting(ctx: Context, input: z.infer<typeof requestSettingInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${input.worldId} FOR UPDATE`;
      const userId = await requireCurrentAdmin(tx, ctx, true);
      const key = { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey };
      const prior = await tx.inputEvent.findUnique({ where: { worldId_userId_idempotencyKey: key } });
      const payload = adminSettingPayloadSchema.parse({ version: 1, reason: input.reason, setting: input.setting });
      if (prior) {
        if (prior.kind !== payload.setting.kind || hashState(prior.payload) !== hashState(payload))
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return response(prior);
      }
      const world = await tx.world.findUnique({
        where: { id: input.worldId },
        select: { status: true, replayFormat: true },
      });
      if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
      if (world.replayFormat !== 3)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '이 월드의 재생 형식에서는 사용할 수 없습니다.' });
      if (!['RUNNING', 'PAUSED'].includes(world.status))
        throw new TRPCError({ code: 'CONFLICT', message: '월드 상태가 바뀌었습니다. 다시 조회하세요.' });
      const event = await tx.inputEvent.create({ data: { ...key, kind: payload.setting.kind, payload } });
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId: userId,
          action: 'world.setting.request',
          targetType: 'World',
          targetId: input.worldId,
          worldId: input.worldId,
          reason: input.reason,
          inputEventId: event.id,
          payload: { kind: event.kind, requestId: String(event.id), idempotencyKey: input.idempotencyKey },
        },
      });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
export async function getWorldSettingRequest(ctx: Context, input: z.infer<typeof settingRequestInput>) {
  expectedActor(ctx, input.expectedUserId);
  try {
    return await ctx.db.$transaction(async (tx) => {
      const userId = await requireCurrentAdmin(tx, ctx, false);
      const event = await tx.inputEvent.findUnique({
        where: {
          worldId_userId_idempotencyKey: { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey },
        },
      });
      if (!event || !isAdminSettingKind(event.kind))
        throw new TRPCError({ code: 'NOT_FOUND', message: '월드 설정 요청을 찾을 수 없습니다.' });
      return response(event);
    });
  } catch (error) {
    publicError(error);
  }
}
export async function getWorldSettings(ctx: Context, input: z.infer<typeof worldSettingsInput>) {
  try {
    const result = await ctx.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id=${input.worldId} FOR SHARE`;
      const actorUserId = await requireCurrentAdmin(tx, ctx, false);
      await tx.auditLog.create({
        data: {
          actorKind: 'ADMIN',
          actorUserId,
          action: 'world.setting.read',
          payload: {},
          worldId: input.worldId,
          targetType: 'World',
          targetId: input.worldId,
        },
      });
      const world = await tx.world.findUnique({ where: { id: input.worldId } });
      if (!world) return null;
      const effective = effectiveWorldOptions(
        world.preset === null ? null : parsePreset(world.preset),
        world.runtimeOptions,
      );
      return {
        name: world.name,
        status: world.status,
        startYear: world.startYear,
        endYear: world.endYear,
        turnTermMinutes: world.turnTermMinutes,
        clockRevision: world.clockRevision,
        presetKey: world.presetKey,
        canChangeRules: world.preset !== null,
        rules: effective.presetRules ?? null,
        entry: effective.entry,
        truce: effective.truce,
      };
    });
    if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
    return result;
  } catch (error) {
    publicError(error);
  }
}
