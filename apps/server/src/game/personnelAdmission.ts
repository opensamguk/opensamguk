import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '@opensamguk/db';
import {
  canManagePersonnel,
  isAppointableOfficerLevel,
  PERSONNEL_INPUTS,
  type PersonnelInputKind,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { requireGeneral, requireWorld } from './queries';
import type { PersonnelReady } from './personnelRequests';

export type PersonnelIdentity = { userId: string; sessionId: string; at: Date };
const kinds = ['personnel.appoint', 'personnel.dismiss', 'offer.respond'] as const;

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
}): PersonnelReady {
  if (world.replayFormat !== 3 || !world.ruleFeatures.includes('personnel'))
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '이 월드에서 인사 기능을 사용할 수 없습니다.' });
  return { worldId: world.id, personnel: 'ready' };
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
  if (kind.data === 'offer.respond') {
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
      if (!('officerLevel' in payload) || !isAppointableOfficerLevel(payload.officerLevel))
        throw new TRPCError({ code: 'BAD_REQUEST', message: '임명할 수 없는 직책입니다.' });
      const occupied = await tx.general.findFirst({
        where: { worldId: world.id, nationId: actor.nationId, officerLevel: payload.officerLevel },
        select: { id: true },
      });
      if (occupied) conflict('먼저 해임하세요.');
    } else if (!isAppointableOfficerLevel(target.officerLevel))
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
  if (world.ruleFeatures.includes('policy'))
    await tx.inputEvent.create({
      data: {
        worldId: world.id,
        userId: input.userId,
        generalId: actor.id,
        kind: 'general.active',
        idempotencyKey: `general.active:personnel:${request.data}`,
        payload: {},
        status: 'PENDING',
        sequence: null,
      },
    });
  return { created: true };
}
