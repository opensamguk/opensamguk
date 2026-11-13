import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  canManagePersonnel,
  COURT_ABILITY_FEATURE,
  COURT_RANK_FEATURE,
  courtAbilityRequirement,
  courtOfficeTitle,
  isAppointableOfficerLevel,
  isLocalOffice,
  hasCitySecretary,
  localOfficeAbility,
  OFFICE_EFFECTS_FEATURE,
  officeEffectsSchema,
  CITY_OFFICE_VOLUNTEER_FEATURE,
  PERSONNEL_INPUTS,
  PERSONNEL_QUEUED_KINDS,
  type PersonnelInputKind,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireGeneral, requireWorld } from './queries';
import type { PersonnelReady } from './personnelRequests';

export type PersonnelIdentity = { userId: string; sessionId: string; at: Date };
const kinds = PERSONNEL_QUEUED_KINDS;

export async function requirePersonnelSession(tx: Prisma.TransactionClient, input: PersonnelIdentity) {
  if (!input.sessionId || !input.userId || !Number.isFinite(input.at.getTime()))
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  const session = await tx.session.findFirst({
    where: { id: input.sessionId, userId: input.userId, expiresAt: { gt: input.at }, user: { status: 'ACTIVE' } },
    select: { id: true },
  });
  if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
}

export function requirePersonnelWorld(world: {
  id: string;
  replayFormat: number;
  ruleFeatures: readonly string[];
  officeEffects?: unknown;
}): PersonnelReady {
  if (world.replayFormat !== 3 || !world.ruleFeatures.includes('personnel'))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '이 월드에서 인사 기능을 사용할 수 없습니다.' });
  const officeEffects = world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE)
    ? officeEffectsSchema.safeParse(world.officeEffects).data
    : undefined;
  return {
    worldId: world.id,
    personnel: 'ready',
    ...(world.ruleFeatures.includes(COURT_RANK_FEATURE) ? { courtRankEnabled: true as const } : {}),
    ...(world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE) ? { officeEffectsEnabled: true as const } : {}),
    ...(officeEffects ? { localOfficeMinimum: officeEffects.minimumAbility } : {}),
    ...(world.ruleFeatures.includes(CITY_OFFICE_VOLUNTEER_FEATURE) ? { volunteersEnabled: true as const } : {}),
    ...(hasCitySecretary(officeEffects) ? { secretaryEnabled: true as const } : {}),
  };
}

function conflict(message = '같은 요청 번호로 다른 내용을 보냈습니다.'): never {
  throw new TRPCError({ code: 'CONFLICT', message });
}

// 접수와 동반 활동만 쓴다. 실제 인사 결과는 엔진이 같은 큐에서 판정한다.
export async function submitPersonnelRequest(
  tx: Prisma.TransactionClient,
  input: PersonnelIdentity & { worldId: string; requestId: string; kind: PersonnelInputKind; payload: unknown },
): Promise<{ created: boolean }> {
  await requirePersonnelSession(tx, input);
  const world = await requireWorld(tx, input.worldId, true);
  requirePersonnelWorld(world);
  const request = z.uuid().safeParse(input.requestId);
  const kind = z.enum(kinds).safeParse(input.kind);
  if (!request.success || !kind.success)
    throw new TRPCError({ code: 'BAD_REQUEST', message: '인사 요청을 확인하세요.' });
  const parsed = PERSONNEL_INPUTS[kind.data].payloadSchema.safeParse(input.payload);
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: '인사 입력을 확인하세요.' });
  const payload = parsed.data;
  const idempotencyKey = `personnel:${request.data}`;
  const previous = await tx.inputEvent.findUnique({
    where: { worldId_userId_idempotencyKey: { worldId: world.id, userId: input.userId, idempotencyKey } },
  });
  if (previous) {
    if (previous.kind !== kind.data || !isDeepStrictEqual(previous.payload, payload)) conflict();
    return { created: false };
  }
  if (world.status !== 'RUNNING')
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '실행 중인 월드가 아닙니다.' });
  const actor = await requireGeneral(tx, world.id, input.userId, true);
  if (kind.data === 'personnel.volunteer') {
    if (
      !world.ruleFeatures.includes(CITY_OFFICE_VOLUNTEER_FEATURE) ||
      actor.nationId === null ||
      actor.removedAt !== null
    )
      throw new TRPCError({ code: 'FORBIDDEN', message: '도시 관직 자원을 사용할 수 없습니다.' });
  } else if (kind.data === 'offer.respond') {
    if (!('offerId' in payload)) throw new Error('발령 응답 입력이 다릅니다.');
    const offer = await tx.assignmentOffer.findUnique({
      where: { worldId_id: { worldId: world.id, id: payload.offerId } },
    });
    if (!offer || offer.targetGeneralId !== actor.id)
      throw new TRPCError({ code: 'NOT_FOUND', message: '발령 제안이 없습니다.' });
    if (offer.status !== 'PENDING') conflict('이미 처리한 발령 제안입니다.');
  } else {
    if (actor.nationId === null || !canManagePersonnel(actor.officerLevel))
      throw new TRPCError({ code: 'FORBIDDEN', message: '군주만 임명·해임할 수 있습니다.' });
    if (!('generalId' in payload)) throw new Error('임명·해임 입력이 다릅니다.');
    const target = await tx.general.findUnique({ where: { worldId_id: { worldId: world.id, id: payload.generalId } } });
    if (!target || target.nationId !== actor.nationId || canManagePersonnel(target.officerLevel))
      throw new TRPCError({ code: 'BAD_REQUEST', message: '자기 국가의 군주 외 장수만 가능합니다.' });
    if (kind.data === 'personnel.appoint') {
      const appointment = PERSONNEL_INPUTS['personnel.appoint'].payloadSchema.parse(payload);
      if (isLocalOffice(appointment.officerLevel)) {
        if (!world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE) || appointment.cityKey === undefined)
          throw new TRPCError({ code: 'BAD_REQUEST', message: '직책과 담당 도시를 확인하세요.' });
        const officeEffects = officeEffectsSchema.parse(world.officeEffects);
        if (appointment.officerLevel === 2 && !hasCitySecretary(officeEffects))
          throw new TRPCError({ code: 'BAD_REQUEST', message: '이 월드에서 종사를 임명할 수 없습니다.' });
        const city = await tx.city.findUnique({
          where: { worldId_cityKey: { worldId: world.id, cityKey: appointment.cityKey } },
        });
        if (!city || city.nationId !== actor.nationId || city.kind === 'PASS')
          throw new TRPCError({ code: 'BAD_REQUEST', message: '자기 국가의 도시만 담당할 수 있습니다.' });
        if (
          target.removedAt !== null ||
          !localOfficeAbility(target, appointment.officerLevel, officeEffects.minimumAbility)
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: '임명 자격을 갖춘 일반 장수만 가능합니다.' });
        if (appointment.expectedHolderId !== undefined) {
          const holder = await tx.general.findFirst({
            where: { worldId: world.id, officerCityKey: appointment.cityKey, officerLevel: appointment.officerLevel },
            select: { id: true },
          });
          if (appointment.expectedHolderId !== (holder?.id ?? null))
            conflict('담당 장수가 바뀌었습니다. 다시 확인하세요.');
        }
      } else {
        if (
          !isAppointableOfficerLevel(appointment.officerLevel) ||
          appointment.cityKey !== undefined ||
          appointment.expectedHolderId !== undefined
        )
          throw new TRPCError({ code: 'BAD_REQUEST', message: '임명할 수 없는 직책입니다.' });
        if (world.ruleFeatures.includes(COURT_RANK_FEATURE)) {
          const nation = await tx.nation.findUniqueOrThrow({
            where: { worldId_id: { worldId: world.id, id: actor.nationId! } },
            select: { level: true },
          });
          if (courtOfficeTitle(nation.level, appointment.officerLevel) === null)
            throw new TRPCError({ code: 'BAD_REQUEST', message: '현재 작위에서 열리지 않은 직책입니다.' });
        }
        if (world.ruleFeatures.includes(COURT_ABILITY_FEATURE)) {
          const required = courtAbilityRequirement(appointment.officerLevel);
          if (target.removedAt !== null || (required && target[required.stat] < required.minimum))
            throw new TRPCError({ code: 'BAD_REQUEST', message: '임명 자격을 갖춘 장수만 가능합니다.' });
        }
        const occupied = await tx.general.findFirst({
          where: { worldId: world.id, nationId: actor.nationId, officerLevel: appointment.officerLevel },
          select: { id: true },
        });
        if (occupied) conflict('먼저 해임하세요.');
      }
    } else if (
      !isAppointableOfficerLevel(target.officerLevel) &&
      !(
        world.ruleFeatures.includes(OFFICE_EFFECTS_FEATURE) &&
        isLocalOffice(target.officerLevel) &&
        target.officerCityKey !== null
      )
    )
      throw new TRPCError({ code: 'BAD_REQUEST', message: '해임할 직책이 없습니다.' });
  }
  const pending = await tx.inputEvent.findMany({
    where: {
      worldId: world.id,
      status: 'PENDING',
      kind: { in: [...kinds] },
      OR: [
        { generalId: actor.id },
        ...(kind.data === 'offer.respond' && 'offerId' in payload
          ? [{ kind: 'offer.respond', payload: { path: ['offerId'], equals: payload.offerId } }]
          : []),
      ],
    },
    select: { id: true },
  });
  if (pending.length) conflict('요청을 처리하는 중입니다.');
  await tx.inputEvent.create({
    data: {
      worldId: world.id,
      userId: input.userId,
      generalId: actor.id,
      kind: kind.data,
      idempotencyKey,
      payload: payload as Prisma.InputJsonValue,
      status: 'PENDING',
      sequence: null,
    },
  });
  if (world.ruleFeatures.includes('policy')) {
    // 대기 활동만 합친다. 기존 행은 보존하고 다른 저장 오류는 접수와 함께 롤백한다.
    const activityKey = `general.active:personnel:${request.data}`;
    await tx.$executeRaw`INSERT INTO "InputEvent" ("worldId","userId","generalId",kind,"idempotencyKey",payload,status)
      VALUES (${world.id},${input.userId},${actor.id},'general.active',${activityKey},'{}'::jsonb,'PENDING')
      ON CONFLICT ("worldId","generalId") WHERE status='PENDING' AND kind='general.active' DO NOTHING`;
  }
  return { created: true };
}
