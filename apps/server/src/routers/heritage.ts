import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  HERITAGE_BENEFIT_KIND,
  HERITAGE_SPECIALTY_FEATURE,
  HERITAGE_SPECIALTY_KIND,
  HERITAGE_TURN_TIME_KIND,
  heritageTurnTimeQuote,
  heritageTurnTimeInput,
  storedHeritageTurnTime,
  combatSpecialty,
  combatSpecialtyNames,
  heritageSpecialtyCost,
  heritageSpecialtyInput,
  heritageSpecialtyPurchase,
  heritageSpecialtyResetCost,
  storedHeritageSpecialty,
  BATTLE_TACTICS_FEATURE,
  battleHeritageBenefits,
  HERITAGE_BENEFITS_FEATURE,
  heritageBenefitCosts,
  heritageBenefitInput,
  heritageBenefitNames,
  heritagePurchase,
  storedHeritageBenefits,
} from '@opensamguk/rules';
import { router, protectedProcedure, worldVerifiedProcedure } from '../trpc';
import { requireGeneral, requireRuleFeature, requireWorld, worldInput } from '../game/queries';
import { nextTurnAt } from '../queries';
import { PgHeritageReadStore } from '../heritage/pgStore';
import { HeritageReadError, readHeritageMine } from '../heritage/service';

export const heritageRouter = router({
  mine: protectedProcedure.input(z.undefined()).query(async ({ ctx }) => {
    try {
      return await readHeritageMine(new PgHeritageReadStore(ctx.db), {
        userId: ctx.user.id,
        sessionId: ctx.sessionId,
        now: ctx.now,
      });
    } catch (error) {
      if (error instanceof HeritageReadError) throw new TRPCError({ code: error.code, message: error.message });
      throw error;
    }
  }),
  benefits: worldVerifiedProcedure.input(worldInput).query(({ ctx, input }) =>
    ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const general = await requireGeneral(tx, world.id, ctx.user.id);
        if (!world.ruleFeatures.includes(HERITAGE_BENEFITS_FEATURE)) return { enabled: false as const };
        const { heritageBenefits } = storedHeritageBenefits(true, general.heritageBenefits);
        const balance = await tx.heritageAccount.findUnique({
          where: { userId: ctx.user.id },
          select: { balance: true },
        });
        const latest = await tx.inputEvent.findFirst({
          where: {
            worldId: world.id,
            userId: ctx.user.id,
            generalId: general.id,
            kind: { in: [HERITAGE_BENEFIT_KIND, HERITAGE_SPECIALTY_KIND, HERITAGE_TURN_TIME_KIND] },
          },
          orderBy: { id: 'desc' },
          select: { status: true, result: true },
        });
        const result = latest?.result;
        const { heritageSpecialty } = storedHeritageSpecialty(
          world.ruleFeatures.includes(HERITAGE_SPECIALTY_FEATURE),
          general.heritageSpecialty,
        );
        const current =
          combatSpecialty(world, heritageSpecialty ? general.combatSpecial : general.special)?.name ?? null;
        const timing = heritageTurnTimeQuote({
          nextTurnTick: general.nextTurnTick,
          ...storedHeritageTurnTime(general.heritageTurnTime),
        });
        return {
          enabled: true as const,
          ...(world.ruleFeatures.includes(HERITAGE_SPECIALTY_FEATURE)
            ? {
                turnTime: {
                  ...timing,
                  pendingAt: timing.pendingTick === null ? null : nextTurnAt(world, timing.pendingTick),
                },
                specialty: {
                  current,
                  next: heritageSpecialty?.next ?? null,
                  resetCost: current ? heritageSpecialtyResetCost(heritageSpecialty?.resets ?? 0) : null,
                  reserveCost: heritageSpecialtyCost,
                  options: combatSpecialtyNames.flatMap((name) => {
                    const entry = combatSpecialty(world, name);
                    return entry ? [{ name, description: entry.description }] : [];
                  }),
                },
              }
            : {}),
          generalId: general.id,
          canPurchase: world.status === 'RUNNING' && general.removedAt === null,
          balance: balance?.balance ?? 0,
          costs: heritageBenefitCosts,
          options: Object.entries(heritageBenefitNames)
            .filter(
              ([key]) =>
                world.ruleFeatures.includes(BATTLE_TACTICS_FEATURE) ||
                !(battleHeritageBenefits as readonly string[]).includes(key),
            )
            .map(([key, label]) => {
              const benefit = heritageBenefitInput.shape.benefit.parse(key);
              return { benefit, label, level: heritageBenefits?.[benefit] ?? 0 };
            }),
          latest: latest
            ? {
                status: latest.status,
                message:
                  result && typeof result === 'object' && !Array.isArray(result) && typeof result.message === 'string'
                    ? result.message
                    : null,
              }
            : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  ),
  specialty: worldVerifiedProcedure
    .input(
      worldInput
        .extend({
          requestId: z.uuid(),
          action: heritageSpecialtyInput,
          expectedGeneralId: z.number().int().positive(),
          expectedCost: z.number().int().positive().max(2_147_483_647),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const world = await requireWorld(tx, input.worldId, true);
        requireRuleFeature(world, HERITAGE_SPECIALTY_FEATURE);
        if (world.status !== 'RUNNING')
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
        const general = await requireGeneral(tx, world.id, ctx.user.id, true);
        if (general.id !== input.expectedGeneralId || general.removedAt !== null)
          throw new TRPCError({ code: 'CONFLICT', message: '내 장수를 다시 확인하세요.' });
        const idempotencyKey = HERITAGE_SPECIALTY_KIND + ':' + input.requestId;
        const prior = await tx.inputEvent.findUnique({
          where: { worldId_userId_idempotencyKey: { worldId: world.id, userId: ctx.user.id, idempotencyKey } },
          select: { id: true, payload: true, generalId: true },
        });
        if (prior) {
          if (prior.generalId !== general.id || !isDeepStrictEqual(prior.payload, input.action))
            throw new TRPCError({ code: 'CONFLICT', message: '같은 요청 번호의 내용이 다릅니다.' });
          return { id: String(prior.id) };
        }
        const purchase = heritageSpecialtyPurchase(
          world,
          {
            special: general.special,
            ...(general.heritageSpecialty === null ? {} : { combatSpecial: general.combatSpecial }),
            ...storedHeritageSpecialty(true, general.heritageSpecialty),
          },
          input.action,
        );
        if (!purchase || purchase.cost !== input.expectedCost)
          throw new TRPCError({ code: 'CONFLICT', message: '전투 특기와 구매 가격을 다시 확인하세요.' });
        const pending = await tx.inputEvent.findFirst({
          where: { worldId: world.id, generalId: general.id, kind: HERITAGE_SPECIALTY_KIND, status: 'PENDING' },
          select: { id: true },
        });
        if (pending) throw new TRPCError({ code: 'CONFLICT', message: '다른 전투 특기 구매를 처리하고 있습니다.' });
        const balance = await tx.heritageAccount.findUnique({
          where: { userId: ctx.user.id },
          select: { balance: true },
        });
        if ((balance?.balance ?? 0) < purchase.cost)
          throw new TRPCError({ code: 'CONFLICT', message: '유산 포인트가 부족합니다.' });
        const event = await tx.inputEvent.create({
          data: {
            worldId: world.id,
            userId: ctx.user.id,
            generalId: general.id,
            kind: HERITAGE_SPECIALTY_KIND,
            idempotencyKey,
            payload: input.action,
          },
          select: { id: true },
        });
        return { id: String(event.id) };
      }),
    ),
  turnTime: worldVerifiedProcedure
    .input(
      worldInput
        .extend({ ...heritageTurnTimeInput.shape, requestId: z.uuid(), expectedGeneralId: z.number().int().positive() })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const world = await requireWorld(tx, input.worldId, true);
        requireRuleFeature(world, HERITAGE_SPECIALTY_FEATURE);
        if (world.status !== 'RUNNING')
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
        const general = await requireGeneral(tx, world.id, ctx.user.id, true);
        if (general.id !== input.expectedGeneralId || general.removedAt !== null)
          throw new TRPCError({ code: 'CONFLICT', message: '내 장수를 다시 확인하세요.' });
        const idempotencyKey = HERITAGE_TURN_TIME_KIND + ':' + input.requestId;
        const payload = { expectedCost: input.expectedCost };
        const prior = await tx.inputEvent.findUnique({
          where: { worldId_userId_idempotencyKey: { worldId: world.id, userId: ctx.user.id, idempotencyKey } },
          select: { id: true, payload: true, generalId: true },
        });
        if (prior) {
          if (prior.generalId !== general.id || !isDeepStrictEqual(prior.payload, payload))
            throw new TRPCError({ code: 'CONFLICT', message: '같은 요청 번호의 내용이 다릅니다.' });
          return { id: String(prior.id) };
        }
        const quote = heritageTurnTimeQuote({
          nextTurnTick: general.nextTurnTick,
          ...storedHeritageTurnTime(general.heritageTurnTime),
        });
        if (quote.cost !== input.expectedCost)
          throw new TRPCError({ code: 'CONFLICT', message: '턴 시간 초기화 비용이나 예약 상태가 바뀌었습니다.' });
        const pending = await tx.inputEvent.findFirst({
          where: { worldId: world.id, generalId: general.id, kind: HERITAGE_TURN_TIME_KIND, status: 'PENDING' },
          select: { id: true },
        });
        if (pending) throw new TRPCError({ code: 'CONFLICT', message: '이미 턴 시간 초기화를 처리하고 있습니다.' });
        const balance = await tx.heritageAccount.findUnique({
          where: { userId: ctx.user.id },
          select: { balance: true },
        });
        if ((balance?.balance ?? 0) < input.expectedCost)
          throw new TRPCError({ code: 'CONFLICT', message: '유산 포인트가 부족합니다.' });
        const event = await tx.inputEvent.create({
          data: {
            worldId: world.id,
            userId: ctx.user.id,
            generalId: general.id,
            kind: HERITAGE_TURN_TIME_KIND,
            idempotencyKey,
            payload,
          },
          select: { id: true },
        });
        return { id: String(event.id) };
      }),
    ),
  purchase: worldVerifiedProcedure
    .input(
      heritageBenefitInput.extend({
        ...worldInput.shape,
        expectedGeneralId: z.number().int().positive(),
        expectedCost: z.number().int().min(1).max(15),
      }),
    )
    .mutation(({ ctx, input }) =>
      ctx.db.$transaction(async (tx) => {
        const world = await requireWorld(tx, input.worldId, true);
        requireRuleFeature(world, HERITAGE_BENEFITS_FEATURE);
        if ((battleHeritageBenefits as readonly string[]).includes(input.benefit))
          requireRuleFeature(world, BATTLE_TACTICS_FEATURE);
        if (world.status !== 'RUNNING')
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
        const general = await requireGeneral(tx, world.id, ctx.user.id, true);
        if (general.id !== input.expectedGeneralId || general.removedAt !== null)
          throw new TRPCError({ code: 'CONFLICT', message: '내 장수를 다시 확인하세요.' });
        const payload = { benefit: input.benefit, level: input.level };
        const { heritageBenefits } = storedHeritageBenefits(true, general.heritageBenefits);
        const purchase = heritagePurchase(heritageBenefits, payload);
        if (!purchase || purchase.cost !== input.expectedCost)
          throw new TRPCError({ code: 'CONFLICT', message: '혜택의 단계와 구매 가격을 다시 확인하세요.' });
        const pending = await tx.inputEvent.findFirst({
          where: { worldId: world.id, generalId: general.id, kind: HERITAGE_BENEFIT_KIND, status: 'PENDING' },
          select: { id: true, userId: true, payload: true },
        });
        if (pending) {
          if (
            pending.userId !== ctx.user.id ||
            !isDeepStrictEqual(heritageBenefitInput.parse(pending.payload), payload)
          )
            throw new TRPCError({ code: 'CONFLICT', message: '다른 혜택 구매를 처리하고 있습니다.' });
          return { status: 'pending' as const, id: String(pending.id) };
        }
        const balance = await tx.heritageAccount.findUnique({
          where: { userId: ctx.user.id },
          select: { balance: true },
        });
        if ((balance?.balance ?? 0) < purchase.cost)
          throw new TRPCError({ code: 'CONFLICT', message: '유산 포인트가 부족합니다.' });
        const event = await tx.inputEvent.create({
          data: {
            worldId: world.id,
            userId: ctx.user.id,
            generalId: general.id,
            kind: HERITAGE_BENEFIT_KIND,
            idempotencyKey: `${HERITAGE_BENEFIT_KIND}:${randomUUID()}`,
            payload,
          },
          select: { id: true },
        });
        return { status: 'pending' as const, id: String(event.id) };
      }),
    ),
});
