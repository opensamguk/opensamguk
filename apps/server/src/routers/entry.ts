import { setTimeout as delay } from 'node:timers/promises';
import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  POSSESSION_KIND,
  HUMAN_GENERAL_LIMIT,
  GENERAL_PROFICIENCY_FEATURE,
  proficiencyByArmType,
  unitSetSchema,
  POSSESSION_ERRORS,
  possessionPayloadSchema,
  possessionAppliedSchema,
  possessionRejectedSchema,
  validatePossessionRecord,
  availableNpc,
  classifyRole,
  recommendNations,
  effectiveWorldOptions,
  parsePreset,
  toGameDate,
  nowTick,
  type EntryRole,
} from '@opensamguk/rules';
import type { Context } from '../context';
import { router, protectedProcedure, worldVerifiedProcedure } from '../trpc';
import { countHumanGenerals, worldInput, worldClock } from '../queries';
import { requireWorld, readView } from '../game/queries';
import { generalProgress } from '../game/generalProgress';
import { generalType } from '../visibility';

const statusInput = worldInput.extend({ expectedUserId: z.uuid(), idempotencyKey: z.uuid() }).strict();
const possessInput = statusInput.extend({ generalId: possessionPayloadSchema.shape.generalId }).strict();
type PossessionReply =
  | { status: 'pending' }
  | { status: 'possessed'; generalId: number }
  | { status: 'rejected'; rejectCode: keyof typeof POSSESSION_ERRORS; message: string };
const rejected = (rejectCode: keyof typeof POSSESSION_ERRORS): PossessionReply => ({
  status: 'rejected',
  rejectCode,
  message: POSSESSION_ERRORS[rejectCode],
});
function expectedActor(ctx: Context, expectedUserId: string) {
  if (!ctx.user || ctx.user.id !== expectedUserId)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인한 계정이 바뀌었습니다. 다시 확인하세요.' });
}

async function currentSession(tx: Prisma.TransactionClient, ctx: Context, worldId: string, started: number) {
  if (!ctx.user || !ctx.sessionId) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  const userId = ctx.user.id,
    sessionId = ctx.sessionId;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id=${sessionId} AND "userId"=${userId} FOR SHARE`;
  const at = new Date(ctx.now + performance.now() - started);
  const session = await tx.session.findFirst({
    where: { id: sessionId, userId, expiresAt: { gt: at }, user: { status: 'ACTIVE' } },
    select: { id: true },
  });
  if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  if (
    await tx.sanction.findFirst({
      where: {
        userId,
        liftedAt: null,
        AND: [{ OR: [{ worldId: null }, { worldId }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] }],
      },
      select: { id: true },
    })
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: '이 월드의 이용이 제한됐습니다.' });
  return userId;
}

function resultOf(event: Prisma.InputEventGetPayload<Record<string, never>>): PossessionReply {
  const payload = possessionPayloadSchema.parse(event.payload);
  if (event.kind !== POSSESSION_KIND || payload.userId !== event.userId)
    throw Error('장수 맡기 요청의 출처가 다릅니다.');
  if (event.status === 'PENDING') {
    if (event.generalId !== null || event.sequence !== null || event.tick !== null || event.result !== null)
      throw Error('대기 중인 장수 맡기 기록을 확인하세요.');
    return { status: 'pending' };
  }
  validatePossessionRecord({
    sequence: event.sequence!,
    tick: event.tick,
    generalId: event.generalId,
    kind: event.kind,
    status: event.status,
    payload: event.payload,
    result: event.result,
  });
  if (event.status === 'APPLIED')
    return { status: 'possessed', generalId: possessionAppliedSchema.parse(event.result).generalId };
  return rejected(possessionRejectedSchema.parse(event.result).code);
}

async function requestResult(ctx: Context, input: z.infer<typeof statusInput>, started: number) {
  return ctx.db.$transaction(async (tx) => {
    const userId = await currentSession(tx, ctx, input.worldId, started);
    const event = await tx.inputEvent.findUnique({
      where: {
        worldId_userId_idempotencyKey: { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey },
      },
    });
    if (!event || event.kind !== POSSESSION_KIND)
      throw new TRPCError({ code: 'NOT_FOUND', message: '장수 맡기 요청을 찾을 수 없습니다.' });
    const result = resultOf(event);
    await currentSession(tx, ctx, input.worldId, started);
    return result;
  });
}

export const entryRouter = router({
  roles: protectedProcedure.input(worldInput).query(async ({ ctx, input }) => {
    const started = performance.now();
    return ctx.db.$transaction(
      async (tx) => {
        const world = await requireWorld(tx, input.worldId);
        const userId = await currentSession(tx, ctx, input.worldId, started);
        const mine = await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId } },
          select: { id: true },
        });
        const pending = await tx.inputEvent.findFirst({
          where: {
            worldId: input.worldId,
            userId,
            status: 'PENDING',
            kind: { in: ['general.create', POSSESSION_KIND] },
          },
          select: { id: true },
        });
        const enabled =
          world.replayFormat === 3 &&
          effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions).entry
            .npcPlay === 'on';
        const humans = await countHumanGenerals(tx, input.worldId);
        const blockedReason = mine
          ? POSSESSION_ERRORS.ALREADY_HAS_GENERAL
          : !enabled
            ? POSSESSION_ERRORS.ENTRY_CLOSED
            : !['PREOPEN', 'RUNNING'].includes(world.status)
              ? POSSESSION_ERRORS.NOT_ELIGIBLE
              : pending
                ? '입장 요청을 처리하고 있습니다.'
                : humans >= HUMAN_GENERAL_LIMIT
                  ? POSSESSION_ERRORS.WORLD_FULL
                  : null;
        const tick = nowTick(worldClock(world), ctx.now);
        type Candidate = {
          generalId: number;
          name: string;
          portraitId: number | null;
          nation: { id: number; name: string; color: string } | null;
          city: { key: number; name: string };
          leadership: number;
          strength: number;
          intel: number;
          politics?: number;
          charm?: number;
          proficiency?: ReturnType<typeof proficiencyByArmType>;
          officerLevel: number;
          age: number;
          dedication: number;
          personality?: string;
          special?: string;
          generalType: ReturnType<typeof generalType>;
          progression: ReturnType<typeof generalProgress>;
          recommendedNation: { id: number; name: string; reason: string } | null;
        };
        const gameDate = toGameDate(world.startYear, tick);
        const roles: Record<EntryRole, Candidate[]> = { ruler: [], core: [], retainer: [], free: [] };
        if (blockedReason === null) {
          const view = await readView(tx, input.worldId);
          const unitSet = world.ruleFeatures.includes(GENERAL_PROFICIENCY_FEATURE)
            ? unitSetSchema.parse(world.unitSet)
            : undefined;
          const selectable = new Set(
            (
              await tx.general.findMany({
                where: { worldId: input.worldId, userId: null, removedAt: null, turnRevision: { lt: 2_147_483_647 } },
                select: { id: true },
              })
            ).map((row) => row.id),
          );
          const candidates = Object.values(view.generals)
            .filter((general) => selectable.has(general.id) && availableNpc(view, general.id, tick))
            .sort(
              (a, b) =>
                (a.nationId ?? 2_147_483_647) - (b.nationId ?? 2_147_483_647) ||
                b.leadership + b.strength + b.intel - (a.leadership + a.strength + a.intel) ||
                a.id - b.id,
            );
          for (const general of candidates) {
            const nation = general.nationId === null ? null : view.nations[general.nationId]!;
            const suggested = general.nationId === null ? recommendNations(view, general.id, tick)[0] : undefined;
            roles[classifyRole(general)].push({
              generalId: general.id,
              name: general.name,
              portraitId: general.portraitId,
              nation: nation ? { id: nation.id, name: nation.name, color: nation.color } : null,
              city: { key: general.cityKey, name: view.cities[general.cityKey]!.name },
              leadership: general.leadership,
              strength: general.strength,
              intel: general.intel,
              ...(world.ruleFeatures.includes('five-stats')
                ? { politics: general.politics!, charm: general.charm! }
                : {}),
              ...(unitSet ? { proficiency: proficiencyByArmType(unitSet.armTypes, general.proficiency) } : {}),
              officerLevel: general.officerLevel,
              age: Math.max(0, gameDate.year - general.birthYear),
              dedication: general.dedication,
              ...(general.personality ? { personality: general.personality.replace(/^che_/, '') } : {}),
              ...(general.special ? { special: general.special.replace(/^che_/, '') } : {}),
              generalType: generalType(general),
              progression: generalProgress(general.experience, general.dedication),
              recommendedNation: suggested
                ? { id: suggested.id, name: suggested.name, reason: suggested.reason }
                : null,
            });
          }
        }
        return {
          gameDate,
          quota: { humans, max: HUMAN_GENERAL_LIMIT },
          mine: mine ? { generalId: mine.id } : null,
          roles,
          canPossess: blockedReason === null,
          blockedReason,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }),
  possess: worldVerifiedProcedure.input(possessInput).mutation(async ({ ctx, input }): Promise<PossessionReply> => {
    const started = performance.now();
    expectedActor(ctx, input.expectedUserId);
    const immediate = await ctx.db.$transaction(async (tx) => {
      const world = await requireWorld(tx, input.worldId, true);
      const userId = await currentSession(tx, ctx, input.worldId, started);
      const key = { worldId: input.worldId, userId, idempotencyKey: input.idempotencyKey };
      const prior = await tx.inputEvent.findUnique({ where: { worldId_userId_idempotencyKey: key } });
      if (prior) {
        if (
          prior.kind !== POSSESSION_KIND ||
          possessionPayloadSchema.parse(prior.payload).generalId !== input.generalId
        )
          throw new TRPCError({ code: 'CONFLICT', message: '이 요청 번호는 다른 내용에 썼습니다.' });
        return resultOf(prior);
      }
      if (world.replayFormat !== 3 || !['PREOPEN', 'RUNNING'].includes(world.status)) return rejected('NOT_ELIGIBLE');
      if (
        effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions).entry
          .npcPlay !== 'on'
      )
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: POSSESSION_ERRORS.ENTRY_CLOSED });
      if (
        await tx.general.findUnique({
          where: { worldId_userId: { worldId: input.worldId, userId } },
          select: { id: true },
        })
      )
        return rejected('ALREADY_HAS_GENERAL');
      if (
        await tx.inputEvent.findFirst({
          where: {
            worldId: input.worldId,
            userId,
            status: 'PENDING',
            kind: { in: ['general.create', POSSESSION_KIND] },
          },
          select: { id: true },
        })
      )
        throw new TRPCError({ code: 'CONFLICT', message: '입장 요청을 처리하고 있습니다.' });
      if ((await countHumanGenerals(tx, input.worldId)) >= HUMAN_GENERAL_LIMIT) return rejected('WORLD_FULL');
      const target = await tx.general.findUnique({
        where: { worldId_id: { worldId: input.worldId, id: input.generalId } },
      });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: '장수를 찾을 수 없습니다.' });
      if (target.userId !== null) return rejected('TAKEN');
      const view = await readView(tx, input.worldId);
      if (target.turnRevision >= 2_147_483_647 || !availableNpc(view, target.id, nowTick(worldClock(world), ctx.now)))
        return rejected('NOT_ELIGIBLE');
      await tx.inputEvent.create({
        data: { ...key, generalId: null, kind: POSSESSION_KIND, payload: { generalId: input.generalId, userId } },
      });
      return null;
    });
    if (immediate !== null && immediate.status !== 'pending') {
      await ctx.db.$transaction((tx) => currentSession(tx, ctx, input.worldId, started));
      return immediate;
    }
    const deadline = started + 5000;
    while (true) {
      const result = await requestResult(ctx, input, started);
      const remaining = deadline - performance.now();
      if (result.status !== 'pending' || remaining <= 0) return result;
      await delay(Math.min(100, remaining));
    }
  }),
  possessStatus: protectedProcedure.input(statusInput).query(async ({ ctx, input }): Promise<PossessionReply> => {
    const started = performance.now();
    expectedActor(ctx, input.expectedUserId);
    return requestResult(ctx, input, started);
  }),
});
