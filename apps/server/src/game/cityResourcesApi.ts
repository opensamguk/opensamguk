import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  applyCityResourceInput,
  campaignArmyTypes,
  checkReplayOrigin,
  cityResourceInputSchema,
  cityResourceResultSchema,
  TICKS_PER_MONTH,
  validateCityResourceRecord,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../context';
import { visibility } from '../visibility';
import { activeSanctionWhere } from '../auth/sanction';
import { requirePersonnelSession } from './personnelAdmission';
import { readView, requireGeneral, requireRuleFeature, requireWorld } from './queries';

type ActorContext = Pick<Context, 'db' | 'sessionId' | 'now'> & { user: { id: string } };
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
const requestSchema = z.uuid();
function identity(ctx: ActorContext, started: number) {
  return { userId: ctx.user.id, sessionId: ctx.sessionId ?? '', at: new Date(ctx.now + performance.now() - started) };
}
function ready(world: Awaited<ReturnType<typeof requireWorld>>) {
  requireRuleFeature(world, 'city-resources-v1');
  if (world.replayFormat !== 3)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '도시 자원 기능을 사용할 수 없습니다.' });
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin);
  if (origin.version !== 3 || !isDeepStrictEqual(origin.initial.ruleFeatures ?? [], world.ruleFeatures))
    throw new Error('도시 자원 기능 사본이 생성 기록과 다릅니다.');
  if (!isDeepStrictEqual(world.unitSet, origin.initial.unitSet)) throw new Error('운영 병종이 생성 기록과 다릅니다.');
  return origin.initial;
}
function requestDto(event: Event) {
  if (event.kind !== 'city.resources' || !event.idempotencyKey.startsWith('city.resources:'))
    throw new Error('도시 자원 요청 종류가 다릅니다.');
  const requestId = requestSchema.parse(event.idempotencyKey.slice('city.resources:'.length));
  if (event.status === 'PENDING') return { requestId, status: 'pending' as const };
  validateCityResourceRecord({
    sequence: event.sequence!,
    tick: event.tick,
    generalId: event.generalId,
    kind: event.kind,
    status: event.status,
    payload: event.payload,
    result: event.result,
  });
  return event.status === 'APPLIED'
    ? { requestId, status: 'applied' as const, result: cityResourceResultSchema.parse(event.result) }
    : {
        requestId,
        status: 'rejected' as const,
        result: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).parse(event.result),
      };
}
export async function readCityResourceRequest(ctx: ActorContext, worldId: string, requestId: string) {
  requestSchema.parse(requestId);
  const started = performance.now();
  return ctx.db.$transaction(
    async (tx) => {
      await requirePersonnelSession(tx, identity(ctx, started));
      ready(await requireWorld(tx, worldId));
      const event = await tx.inputEvent.findUnique({
        where: {
          worldId_userId_idempotencyKey: {
            worldId,
            userId: ctx.user.id,
            idempotencyKey: `city.resources:${requestId}`,
          },
        },
      });
      if (!event || event.kind !== 'city.resources')
        throw new TRPCError({ code: 'NOT_FOUND', message: '도시 자원 요청이 없습니다.' });
      return requestDto(event);
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function submitCityResourceRequest(
  ctx: ActorContext,
  input: { worldId: string; requestId: string; payload: unknown },
) {
  const request = requestSchema.safeParse(input.requestId),
    parsed = cityResourceInputSchema.safeParse(input.payload);
  if (!request.success || !parsed.success)
    throw new TRPCError({ code: 'BAD_REQUEST', message: '도시 병력 배속 입력을 확인하세요.' });
  const started = performance.now();
  await ctx.db.$transaction(async (tx) => {
    const auth = identity(ctx, started);
    await requirePersonnelSession(tx, auth);
    const world = await requireWorld(tx, input.worldId, true),
      initial = ready(world);
    const sanction = await tx.sanction.findFirst({
      where: {
        userId: ctx.user.id,
        AND: [{ OR: [{ worldId: null }, { worldId: world.id }] }],
        ...activeSanctionWhere(auth.at.getTime()),
      },
      select: { id: true },
    });
    if (sanction) throw new TRPCError({ code: 'FORBIDDEN', message: '이 월드의 이용이 제한됐습니다.' });
    const idempotencyKey = `city.resources:${request.data}`;
    const previous = await tx.inputEvent.findUnique({
      where: { worldId_userId_idempotencyKey: { worldId: world.id, userId: ctx.user.id, idempotencyKey } },
    });
    if (previous) {
      if (previous.kind !== 'city.resources' || !isDeepStrictEqual(previous.payload, parsed.data))
        throw new TRPCError({ code: 'CONFLICT', message: '같은 요청 번호로 다른 내용을 보냈습니다.' });
      return;
    }
    if (world.status !== 'RUNNING')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
    const actor = await requireGeneral(tx, world.id, ctx.user.id, true),
      view = await readView(tx, world.id);
    const outcome = applyCityResourceInput(view, parsed.data, actor.id, {
      tick: world.clockTick,
      userId: ctx.user.id,
      userActive: true,
      armyTypes: campaignArmyTypes(initial),
    });
    if (!outcome.ok)
      throw new TRPCError({
        code: ['PROTECTED', 'ACTOR_INACTIVE', 'NOT_NATION', 'NOT_OWN_CITY'].includes(outcome.code)
          ? 'FORBIDDEN'
          : 'BAD_REQUEST',
        message: outcome.message,
      });
    // 자원·부곡·예약은 바꾸지 않고 엔진이 다시 판정할 입력만 접수한다.
    await tx.inputEvent.create({
      data: {
        worldId: world.id,
        userId: ctx.user.id,
        generalId: actor.id,
        kind: 'city.resources',
        idempotencyKey,
        payload: parsed.data as Prisma.InputJsonValue,
        status: 'PENDING',
        sequence: null,
      },
    });
    await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
      VALUES (${world.id},${ctx.user.id},${actor.id},'general.active',${`general.active:city.resources:${request.data}`},'{}'::jsonb,'PENDING')
      ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
  });
  return readCityResourceRequest(ctx, input.worldId, request.data);
}
export async function readCityResourceBoard(ctx: ActorContext, worldId: string, cityKey: number) {
  const started = performance.now();
  return ctx.db.$transaction(
    async (tx) => {
      await requirePersonnelSession(tx, identity(ctx, started));
      const world = await requireWorld(tx, worldId),
        initial = ready(world),
        actor = await requireGeneral(tx, worldId, ctx.user.id),
        view = await readView(tx, worldId);
      const city = view.cities[cityKey];
      if (!city) throw new TRPCError({ code: 'NOT_FOUND', message: '도시를 찾을 수 없습니다.' });
      if (!visibility(actor).city(city)) return { cityKey, visible: false as const };
      const own = actor.nationId !== null && actor.nationId === city.nationId;
      const year = world.startYear + Math.floor(world.clockTick / (12 * TICKS_PER_MONTH));
      const canAllocate =
        own &&
        actor.officerLevel >= 5 &&
        actor.officerLevel <= 12 &&
        actor.activeFromYear <= year &&
        world.status === 'RUNNING';
      const targets = canAllocate
        ? view
            .campaign!.units.filter((unit) =>
              [unit.ownerId, unit.commanderId].every((id) => {
                const person = view.generals[id]!;
                return (
                  person.nationId === actor.nationId && person.cityKey === cityKey && person.activeFromYear <= year
                );
              }),
            )
            .map((unit) => ({
              ...unit,
              ownerName: view.generals[unit.ownerId]!.name,
              commanderName: view.generals[unit.commanderId]!.name,
              capacity: view.generals[unit.commanderId]!.leadership * 100,
              commanded: view
                .campaign!.units.filter((entry) => entry.commanderId === unit.commanderId)
                .reduce((sum, entry) => sum + entry.troops, 0),
            }))
        : [];
      return {
        cityKey,
        visible: true as const,
        status: world.status,
        canAllocate,
        resources: view.cityResources!.cities[String(cityKey)]!,
        targets,
        armyTypes: initial.unitSet.crewTypes
          .filter((type) => campaignArmyTypes(initial).includes(type.id))
          .map(({ id, name }) => ({ id, name })),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
