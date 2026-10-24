import type { Prisma } from '@opensamguk/db';
import { canExecuteNationCommand, decodeTreatyRecord, TREATY_INPUTS, type TreatyRejectCode } from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { requireGeneral, requireWorld } from './queries';
import {
  checkTreatyRow,
  enabledTreatyKinds,
  requireTreatyBreakWorld,
  requireTreatyWorld,
  toTreatyDetail,
  type TreatyDetail,
} from './treatyQueries';
import { treatyTradeEnabled } from './treatyQueries';

export type TreatyRequestKind = keyof typeof TREATY_INPUTS;
export type TreatyRequestState =
  | { status: 'pending'; requestId: string; kind: TreatyRequestKind }
  | {
      status: 'applied';
      requestId: string;
      kind: TreatyRequestKind;
      outcome: 'PROPOSED' | 'ACCEPTED' | 'DECLINED' | 'BROKEN';
      treatyId: string;
      treaty: TreatyDetail | null;
    }
  | { status: 'rejected'; requestId: string; kind: TreatyRequestKind; code: TreatyRejectCode; reason: string };

type Identity = { worldId: string; userId: string; sessionId: string; at: Date; requestId: string };
const requestSchema = z.uuid();
const kindSchema = z.enum(Object.keys(TREATY_INPUTS) as [TreatyRequestKind, ...TreatyRequestKind[]]);

function invalid(): never {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '조약 요청 기록을 확인하지 못했습니다.' });
}
function conflict(): never {
  throw new TRPCError({ code: 'CONFLICT', message: '다른 조약 요청과 식별자가 겹칩니다.' });
}
function parseRequest(requestId: string): string {
  const parsed = requestSchema.safeParse(requestId);
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: '조약 요청 식별자를 확인하세요.' });
  return parsed.data;
}
export function normalizeTreatyRequestPayload(kind: TreatyRequestKind, payload: unknown) {
  try {
    const normalized = TREATY_INPUTS[kind].normalizePayload(payload);
    // JSON 저장에서 -0은 0이 된다. 재전송도 같은 저장 표현으로 비교한다.
    return TREATY_INPUTS[kind].payloadSchema.parse(JSON.parse(JSON.stringify(normalized)));
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: '조약 요청 내용을 확인하세요.' });
  }
}
function storedPayload(kind: TreatyRequestKind, payload: unknown) {
  try {
    return TREATY_INPUTS[kind].payloadSchema.parse(payload);
  } catch {
    invalid();
  }
}

// userId·sessionId·at은 라우터가 세션과 경과 시각에서 정한다.
export async function requireLiveSession(
  tx: Prisma.TransactionClient,
  input: { sessionId: string; userId: string; at: Date },
): Promise<void> {
  if (!input.sessionId || !input.userId || !(input.at instanceof Date) || !Number.isFinite(input.at.getTime()))
    throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
  const session = await tx.session.findFirst({
    where: {
      id: input.sessionId,
      userId: input.userId,
      expiresAt: { gt: input.at },
      user: { status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
}

async function findRequest(
  tx: Prisma.TransactionClient,
  input: Identity,
  requestId: string,
  kinds: readonly TreatyRequestKind[],
) {
  const keys = kinds.map((kind) => `${kind}:${requestId}`);
  const events = await tx.inputEvent.findMany({
    where: { worldId: input.worldId, userId: input.userId, idempotencyKey: { in: keys } },
  });
  if (events.length > 1) conflict();
  const event = events[0];
  if (!event) return null;
  const kind = kindSchema.safeParse(event.kind);
  if (
    !kind.success ||
    event.worldId !== input.worldId ||
    event.userId !== input.userId ||
    event.idempotencyKey !== `${kind.data}:${requestId}`
  )
    invalid();
  return { event, kind: kind.data };
}

// Read Committed 트랜잭션에서 부른다. World 잠금 뒤 기존 nonce를 새 권한보다 먼저 찾는다.
export async function submitTreatyRequest(
  tx: Prisma.TransactionClient,
  input: Identity & { kind: TreatyRequestKind; payload: unknown },
): Promise<{ created: boolean }> {
  const requestId = parseRequest(input.requestId);
  const parsedKind = kindSchema.safeParse(input.kind);
  if (!parsedKind.success) throw new TRPCError({ code: 'BAD_REQUEST', message: '조약 요청 종류를 확인하세요.' });
  const kind = parsedKind.data;
  await requireLiveSession(tx, input);
  const world = await requireWorld(tx, input.worldId, true);
  requireTreatyWorld(world);
  if (kind === 'treaty.break') requireTreatyBreakWorld(world);
  const payload = normalizeTreatyRequestPayload(kind, input.payload);
  const existing = await findRequest(tx, input, requestId, enabledTreatyKinds(world));
  if (existing) {
    if (existing.kind !== kind) conflict();
    if (!isDeepStrictEqual(storedPayload(kind, existing.event.payload), payload)) conflict();
    return { created: false };
  }
  if (world.status === 'ENDED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '종료된 월드입니다.' });
  const actor = await requireGeneral(tx, input.worldId, input.userId, true);
  if (actor.nationId === null || !canExecuteNationCommand(actor.officerLevel, 'nation_pact'))
    throw new TRPCError({ code: 'FORBIDDEN', message: '조약을 처리할 권한이 없습니다.' });
  if (kind === 'treaty.respond' || kind === 'treaty.break') {
    if (!('treatyId' in payload)) invalid();
    const id = Number(payload.treatyId);
    const message = kind === 'treaty.break' ? '파기할 조약이 없습니다.' : '응답할 조약이 없습니다.';
    if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) throw new TRPCError({ code: 'NOT_FOUND', message });
    const treaty = await tx.treaty.findUnique({ where: { worldId_id: { worldId: input.worldId, id } } });
    if (!treaty || (actor.nationId !== treaty.fromNationId && actor.nationId !== treaty.toNationId))
      throw new TRPCError({ code: 'NOT_FOUND', message });
    checkTreatyRow(world, treaty);
  }
  const pending = await tx.inputEvent.findMany({
    where: { worldId: input.worldId, generalId: actor.id, kind, status: 'PENDING' },
  });
  for (const event of pending) {
    const previous = storedPayload(kind, event.payload);
    const sameTarget =
      kind === 'treaty.propose'
        ? 'toNationId' in previous && 'toNationId' in payload && previous.toNationId === payload.toNationId
        : 'treatyId' in previous && 'treatyId' in payload && previous.treatyId === payload.treatyId;
    if (sameTarget) throw new TRPCError({ code: 'CONFLICT', message: '요청을 처리하는 중입니다.' });
  }
  await tx.inputEvent.create({
    data: {
      worldId: input.worldId,
      userId: input.userId,
      generalId: actor.id,
      kind,
      idempotencyKey: `${kind}:${requestId}`,
      payload: payload as Prisma.InputJsonValue,
      status: 'PENDING',
      sequence: null,
      // nullable Json의 기본 SQL NULL을 쓴다. Prisma의 JSON null 값으로 바꾸지 않는다.
    },
  });
  return { created: true };
}

// RepeatableRead 트랜잭션에서 부른다. 라우터는 대기 뒤 반환 직전 이 함수를 다시 부른다.
export async function readTreatyRequest(tx: Prisma.TransactionClient, input: Identity): Promise<TreatyRequestState> {
  const requestId = parseRequest(input.requestId);
  await requireLiveSession(tx, input);
  const world = await requireWorld(tx, input.worldId);
  requireTreatyWorld(world);
  const found = await findRequest(tx, input, requestId, enabledTreatyKinds(world));
  if (!found) throw new TRPCError({ code: 'NOT_FOUND', message: '조약 요청이 없습니다.' });
  const { event, kind } = found;
  if (event.status === 'PENDING') {
    if (
      event.sequence !== null ||
      event.result !== null ||
      event.generalId === null ||
      !Number.isSafeInteger(event.generalId) ||
      event.generalId < 1
    )
      invalid();
    storedPayload(kind, event.payload);
    return { status: 'pending', requestId, kind };
  }
  let record: ReturnType<typeof decodeTreatyRecord>;
  try {
    record = decodeTreatyRecord(
      {
        sequence: event.sequence,
        generalId: event.generalId,
        kind,
        status: event.status,
        payload: event.payload,
        result: event.result,
      },
      { tradeEnabled: treatyTradeEnabled(world) },
    );
  } catch {
    invalid();
  }
  if (record.status === 'REJECTED')
    return { status: 'rejected', requestId, kind, code: record.result.code, reason: record.result.message };
  const id = Number(record.result.treatyId);
  if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) invalid();
  const treaty = await tx.treaty.findUnique({ where: { worldId_id: { worldId: input.worldId, id } } });
  if (!treaty) invalid();
  const checked = checkTreatyRow(world, treaty);
  const actor = await tx.general.findUnique({
    where: { worldId_userId: { worldId: input.worldId, userId: input.userId } },
  });
  return {
    status: 'applied',
    requestId,
    kind,
    outcome: record.result.outcome,
    treatyId: record.result.treatyId,
    treaty: toTreatyDetail(checked, actor?.nationId ?? null),
  };
}
