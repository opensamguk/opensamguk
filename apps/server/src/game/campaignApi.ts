import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  campaignRelationshipInputSchema,
  campaignUnitInputSchema,
  campaignRelationshipResultSchema,
  campaignUnitResultSchema,
  validateCampaignRecord,
  FIVE_STAT_KEYS,
  fiveStatsSchema,
  checkReplayOrigin,
  campaignArmyTypes,
  TICKS_PER_MONTH,
  INITIAL_RENOWN_CAPACITY,
  retinuePersonCost,
  campaignPeople,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../context';
import { requirePersonnelSession } from './personnelAdmission';
import { readView, requireGeneral, requireRuleFeature, requireWorld } from './queries';

type ActorContext = Pick<Context, 'db' | 'sessionId' | 'now'> & { user: { id: string } };
type Kind = 'campaign.relationship' | 'campaign.unit';
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
const kinds: Kind[] = ['campaign.relationship', 'campaign.unit'];
function identity(ctx: ActorContext, started: number) {
  return { userId: ctx.user.id, sessionId: ctx.sessionId ?? '', at: new Date(ctx.now + performance.now() - started) };
}
function ready(world: Awaited<ReturnType<typeof requireWorld>>) {
  requireRuleFeature(world, 'campaign-v1');
  if (world.replayFormat !== 3)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '휘하 기능을 사용할 수 없습니다.' });
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin);
  if (!isDeepStrictEqual(world.unitSet, origin.initial.unitSet)) throw new Error('운영 병종이 생성 기록과 다릅니다.');
  return origin.initial;
}
function requestDto(event: Event) {
  if (!kinds.includes(event.kind as Kind)) throw new Error('휘하 요청 종류가 다릅니다.');
  const requestId = event.idempotencyKey.slice('campaign:'.length);
  if (event.status === 'PENDING') return { requestId, kind: event.kind, status: 'pending' as const };
  validateCampaignRecord({
    sequence: event.sequence!,
    tick: event.tick,
    generalId: event.generalId,
    kind: event.kind,
    status: event.status,
    payload: event.payload,
    result: event.result,
  });
  return event.status === 'APPLIED'
    ? event.kind === 'campaign.relationship'
      ? {
          requestId,
          kind: 'campaign.relationship' as const,
          status: 'applied' as const,
          result: campaignRelationshipResultSchema.parse(event.result),
        }
      : {
          requestId,
          kind: 'campaign.unit' as const,
          status: 'applied' as const,
          result: campaignUnitResultSchema.parse(event.result),
        }
    : {
        requestId,
        kind: event.kind,
        status: 'rejected' as const,
        result: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).parse(event.result),
      };
}
export async function readCampaignRequest(ctx: ActorContext, worldId: string, requestId: string) {
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
            idempotencyKey: `campaign:${requestId}`,
          },
        },
      });
      if (!event || !kinds.includes(event.kind as Kind))
        throw new TRPCError({ code: 'NOT_FOUND', message: '휘하 요청이 없습니다.' });
      return requestDto(event);
    },
    { isolationLevel: 'RepeatableRead' },
  );
}

// 접수와 활동 입력만 저장한다. 소유권·명망·비용·RNG·실제 지휘 상한은 엔진이 다시 검사한다.
export async function submitCampaignRequest(
  ctx: ActorContext,
  input: { worldId: string; requestId: string; kind: Kind; payload: unknown; expectedUserId?: string | undefined },
) {
  const started = performance.now();
  await ctx.db.$transaction(async (tx) => {
    await requirePersonnelSession(tx, identity(ctx, started));
    if (
      input.kind === 'campaign.relationship' &&
      input.expectedUserId !== undefined &&
      input.expectedUserId !== ctx.user.id
    )
      throw new TRPCError({ code: 'FORBIDDEN', message: '로그인한 계정이 바뀌었습니다. 화면을 다시 확인하세요.' });
    const world = await requireWorld(tx, input.worldId, true);
    ready(world);
    const schema = input.kind === 'campaign.relationship' ? campaignRelationshipInputSchema : campaignUnitInputSchema;
    const parsed = schema.safeParse(input.payload);
    if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: '휘하·부곡 입력을 확인하세요.' });
    const payload = parsed.data,
      idempotencyKey = `campaign:${input.requestId}`;
    const previous = await tx.inputEvent.findUnique({
      where: { worldId_userId_idempotencyKey: { worldId: world.id, userId: ctx.user.id, idempotencyKey } },
    });
    if (previous) {
      if (previous.kind !== input.kind || !isDeepStrictEqual(previous.payload, payload))
        throw new TRPCError({ code: 'CONFLICT', message: '같은 요청 번호로 다른 내용을 보냈습니다.' });
      return;
    }
    if (world.status !== 'RUNNING')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
    const actor = await requireGeneral(tx, world.id, ctx.user.id, true);
    const view = await readView(tx, world.id),
      campaign = view.campaign!;
    if (payload.revision !== campaign.revision)
      throw new TRPCError({ code: 'CONFLICT', message: '휘하 현황을 다시 불러오세요.' });
    if ('unitId' in payload && campaign.units.find((unit) => unit.id === payload.unitId)?.ownerId !== actor.id)
      throw new TRPCError({ code: 'FORBIDDEN', message: '자기 부곡만 조작할 수 있습니다.' });
    if (
      payload.type === 'respond' &&
      campaign.offers.find((offer) => offer.id === payload.offerId)?.personId !== actor.id
    )
      throw new TRPCError({ code: 'FORBIDDEN', message: '자신에게 온 휘하 제안만 응답할 수 있습니다.' });
    if (
      payload.type === 'release' &&
      !campaign.links.some(
        (link) => link.personId === payload.personId && (link.masterId === actor.id || link.personId === actor.id),
      )
    )
      throw new TRPCError({ code: 'FORBIDDEN', message: '자신의 직속 관계만 해제할 수 있습니다.' });
    if (
      'commanderId' in payload &&
      payload.commanderId !== actor.id &&
      (view.generals[payload.commanderId]?.userId !== null ||
        !campaign.links.some(
          (link) =>
            link.masterId === actor.id && link.personId === payload.commanderId && link.relation === 'LIEUTENANT',
        ))
    )
      throw new TRPCError({ code: 'FORBIDDEN', message: '본인 또는 직속 NPC 부장만 지휘할 수 있습니다.' });
    const pending = await tx.inputEvent.findFirst({
      where: { worldId: world.id, userId: ctx.user.id, status: 'PENDING', kind: { in: kinds } },
      select: { id: true },
    });
    if (pending) throw new TRPCError({ code: 'CONFLICT', message: '요청을 처리하는 중입니다.' });
    await tx.inputEvent.create({
      data: {
        worldId: world.id,
        userId: ctx.user.id,
        generalId: actor.id,
        kind: input.kind,
        idempotencyKey,
        payload: payload as Prisma.InputJsonValue,
        status: 'PENDING',
        sequence: null,
      },
    });
    await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
      VALUES (${world.id},${ctx.user.id},${actor.id},'general.active',${`general.active:campaign:${input.requestId}`},'{}'::jsonb,'PENDING')
      ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
  });
  return readCampaignRequest(ctx, input.worldId, input.requestId);
}

export async function readCampaignBoard(ctx: ActorContext, worldId: string) {
  const started = performance.now();
  return ctx.db.$transaction(
    async (tx) => {
      await requirePersonnelSession(tx, identity(ctx, started));
      const world = await requireWorld(tx, worldId);
      const initial = ready(world);
      const actor = await requireGeneral(tx, worldId, ctx.user.id);
      const view = await readView(tx, worldId),
        campaign = view.campaign!;
      const year = world.startYear + Math.floor(world.clockTick / (12 * TICKS_PER_MONTH));
      const ids = [actor.id];
      for (let index = 0; index < ids.length; index++)
        ids.push(...campaign.links.filter((link) => link.masterId === ids[index]).map((link) => link.personId));
      const offers = campaign.offers.filter((offer) => offer.personId === actor.id || offer.masterId === actor.id);
      const links = campaign.links.filter((link) => ids.includes(link.masterId) || link.personId === actor.id);
      const visible = new Set([
        ...ids,
        ...links.map((link) => link.masterId),
        ...offers.flatMap((offer) => [offer.masterId, offer.personId]),
      ]);
      const candidates =
        actor.nationId === null
          ? []
          : Object.values(view.generals).filter(
              (general) =>
                general.id !== actor.id &&
                general.cityKey === actor.cityKey &&
                general.officerLevel !== 12 &&
                general.activeFromYear <= year &&
                (general.nationId === null || general.nationId === actor.nationId) &&
                !campaign.links.some((link) => link.personId === general.id),
            );
      for (const general of candidates) visible.add(general.id);
      const people = campaignPeople(view, campaign);
      const person = (id: number) => {
        const general = view.generals[id]!,
          stats = fiveStatsSchema.parse(Object.fromEntries(FIVE_STAT_KEYS.map((key) => [key, general[key]])));
        return {
          id,
          name: general.name,
          portraitId: general.portraitId,
          isHuman: general.userId !== null,
          nationId: general.nationId,
          cityKey: general.cityKey,
          ...stats,
          renownCost: retinuePersonCost(people.find((row) => row.id === id)!.stats),
        };
      };
      return {
        revision: campaign.revision,
        status: world.status,
        actorId: actor.id,
        resources: { gold: actor.gold, rice: actor.rice },
        cityKey: actor.cityKey,
        renownCapacity: INITIAL_RENOWN_CAPACITY,
        armyTypes: initial.unitSet.crewTypes
          .filter((type) => campaignArmyTypes(initial).includes(type.id))
          .map(({ id, name }) => ({ id, name })),
        renownUsed: links
          .filter((link) => link.masterId === actor.id)
          .reduce(
            (sum, link) => sum + retinuePersonCost(people.find((person) => person.id === link.personId)!.stats),
            0,
          ),
        npcPledge: {
          cost: 500,
          chance: 25 + Math.floor(view.generals[actor.id]!.charm! / 2),
          month: Math.floor(world.clockTick / TICKS_PER_MONTH),
          attempts: campaign.attempts.filter((attempt) => attempt.masterId === actor.id),
        },
        people: [...visible].sort((a, b) => a - b).map(person),
        candidates: candidates.map((general) => general.id),
        links,
        offers,
        units: campaign.units
          .filter((unit) => unit.ownerId === actor.id)
          .map((unit) => ({ ...unit, cityKey: view.generals[unit.commanderId]!.cityKey })),
        commanders: [
          actor.id,
          ...campaign.links
            .filter(
              (link) =>
                link.masterId === actor.id &&
                link.relation === 'LIEUTENANT' &&
                view.generals[link.personId]!.userId === null,
            )
            .map((link) => link.personId),
        ]
          .filter((id) => view.generals[id]!.cityKey === actor.cityKey && view.generals[id]!.activeFromYear <= year)
          .map((id) => ({
            id,
            capacity: view.generals[id]!.leadership * 100,
            commanded: campaign.units
              .filter((unit) => unit.commanderId === id)
              .reduce((sum, unit) => sum + unit.troops, 0),
          })),
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
