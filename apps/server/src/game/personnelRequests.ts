import type { Prisma } from '@opensamguk/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

const kinds = ['personnel.appoint', 'personnel.dismiss', 'offer.respond'] as const;
type PersonnelKind = (typeof kinds)[number];
type AppointResult = { generalId: number; officerLevel: number; title: string };
type RespondResult = {
  offerStatus: 'ACCEPTED' | 'REJECTED';
  city: { cityKey: number; name: string };
  dedicationLost: number;
};
type RequestState<R> =
  | { status: 'pending'; requestId: string }
  | { status: 'applied'; requestId: string; result: R }
  | { status: 'rejected'; requestId: string; code: string; message: string };
export type PersonnelRecord = { kind: PersonnelKind; state: RequestState<AppointResult | RespondResult> };
export type PersonnelReady = Readonly<{ worldId: string; personnel: 'ready' }>;
type EventRow = Pick<
  Prisma.InputEventGetPayload<Record<string, never>>,
  'kind' | 'idempotencyKey' | 'status' | 'result'
>;
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const appointResult = z.object({ generalId: positive, officerLevel: z.number().int(), title: z.string().min(1) });
const respondResult = z.object({
  offerStatus: z.enum(['ACCEPTED', 'REJECTED']),
  city: z.object({ cityKey: positive, name: z.string() }),
  dedicationLost: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const rejection = z.object({ code: z.string().min(1), message: z.string().min(1) });
function invalid(): never {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '인사 요청 결과를 확인하지 못했습니다.' });
}
function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}

// 중앙에서 검사한 기록의 표시용 칸만 고른다. 처리 tick과 DB 칸은 화면에 내보내지 않는다.
export function toPersonnelRecord(event: EventRow): PersonnelRecord {
  const kind = read(z.enum(kinds), event.kind);
  if (!event.idempotencyKey.startsWith('personnel:')) invalid();
  const requestId = read(z.uuid(), event.idempotencyKey.slice('personnel:'.length));
  if (event.status === 'PENDING') return { kind, state: { status: 'pending', requestId } };
  if (event.status === 'REJECTED')
    return { kind, state: { status: 'rejected', requestId, ...read(rejection, event.result) } };
  if (event.status !== 'APPLIED') invalid();
  const result = kind === 'offer.respond' ? read(respondResult, event.result) : read(appointResult, event.result);
  return { kind, state: { status: 'applied', requestId, result } };
}

function requireReady(ready: PersonnelReady, worldId: string) {
  if (ready.worldId !== worldId || ready.personnel !== 'ready')
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '인사 기능을 사용할 수 없습니다.' });
}

// userId는 라우터가 세션에서 정한다. 이 함수는 접수나 게임 상태 변경을 하지 않는다.
export async function readPersonnelRequest(
  tx: Prisma.TransactionClient,
  ready: PersonnelReady,
  input: { worldId: string; userId: string; requestId: string },
): Promise<PersonnelRecord> {
  requireReady(ready, input.worldId);
  const requestId = read(z.uuid(), input.requestId);
  const event = await tx.inputEvent.findUnique({
    where: {
      worldId_userId_idempotencyKey: {
        worldId: input.worldId,
        userId: input.userId,
        idempotencyKey: `personnel:${requestId}`,
      },
    },
  });
  if (!event || !kinds.some((kind) => kind === event.kind))
    throw new TRPCError({ code: 'NOT_FOUND', message: '인사 요청이 없습니다.' });
  return toPersonnelRecord(event);
}

export async function readPersonnelRecent(
  tx: Prisma.TransactionClient,
  ready: PersonnelReady,
  input: { worldId: string; userId: string; now: number },
): Promise<PersonnelRecord[]> {
  requireReady(ready, input.worldId);
  const since = new Date(input.now - 24 * 60 * 60 * 1000);
  if (!Number.isSafeInteger(input.now) || !Number.isFinite(since.getTime())) invalid();
  const events = await tx.inputEvent.findMany({
    where: { worldId: input.worldId, userId: input.userId, kind: { in: [...kinds] }, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 5,
  });
  return events.map(toPersonnelRecord);
}
