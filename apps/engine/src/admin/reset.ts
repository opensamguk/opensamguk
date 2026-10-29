import { setTimeout as delay } from 'node:timers/promises';
import { nextActionSequence, type Prisma, type PrismaClient } from '@opensamguk/db';
import {
  ADMIN_RESET_KIND,
  adminResetPayloadSchema,
  adminResetAppliedSchema,
  adminResetRejectMessages,
  checkAdminEndOrigin,
  checkReplayOrigin,
  validateAdminResetRecord,
  type AdminResetRejectCode,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { databaseNow, renewLease, type Lease } from '../lease';
import { loadReplayState } from '../monthly';
import { savePreparedInitialWorld } from '../world/persistence';
import {
  prepareWorldReset,
  verifyResetPreparation,
  resetSourceSettingsHash,
  resetSettingsReference,
  ResetPreparationError,
  type ResetPreparation,
} from './resetPreparation';

type World = Prisma.WorldGetPayload<Record<string, never>>;
type Event = Prisma.InputEventGetPayload<Record<string, never>>;
export interface PendingResetPreparation {
  readonly eventId: bigint;
  readonly binding: string;
  readonly candidate: ResetPreparation | null;
  readonly rejection: AdminResetRejectCode | null;
}
const trusted = new WeakSet<PendingResetPreparation>();
function eventBinding(event: Event) {
  return hashState({
    id: String(event.id),
    worldId: event.worldId,
    userId: event.userId,
    idempotencyKey: event.idempotencyKey,
    kind: event.kind,
    payload: event.payload,
    generalId: event.generalId,
    status: event.status,
    sequence: event.sequence,
    tick: event.tick,
    stepTick: event.stepTick,
    result: event.result,
  });
}
function pendingPayload(event: Event) {
  const payload = adminResetPayloadSchema.parse(event.payload);
  if (
    event.kind !== ADMIN_RESET_KIND ||
    event.worldId !== payload.sourceWorldId ||
    event.status !== 'PENDING' ||
    event.generalId !== null ||
    event.sequence !== null ||
    event.tick !== null ||
    event.stepTick !== null ||
    event.result !== null
  )
    throw new Error('대기 중인 초기화 요청 기록이 다릅니다.');
  return payload;
}
function resourceRejection(error: ResetPreparationError): AdminResetRejectCode {
  return error.code === 'UNSUPPORTED_FORMAT' ? 'UNSUPPORTED_FORMAT' : 'RESOURCE_INVALID';
}

/** The first fenced probe only reads the pending event. Preparation runs outside its apply TX. */
export async function preparePendingReset(
  db: PrismaClient,
  lease: Lease,
  event: Event,
  signal?: AbortSignal,
): Promise<PendingResetPreparation> {
  const payload = pendingPayload(event);
  if (lease.worldId !== event.worldId) throw new Error('초기화 실행권의 월드가 다릅니다.');
  signal?.throwIfAborted();
  await renewLease(db, lease);
  signal?.throwIfAborted();
  const stop = new AbortController(),
    combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let renewalError: unknown,
    preparationError: unknown,
    candidate: ResetPreparation | null = null;
  const renewal = (async () => {
    while (!combined.aborted) {
      try {
        await delay(Math.max(1, Math.floor(lease.ttlMs / 3)), undefined, { signal: combined });
      } catch (error) {
        if (!combined.aborted) renewalError = error;
        break;
      }
      if (combined.aborted) break;
      try {
        await renewLease(db, lease);
      } catch (error) {
        renewalError = error;
        stop.abort(error);
        break;
      }
    }
  })();
  try {
    candidate = await prepareWorldReset(db, event.worldId, payload.effectiveSeed, combined);
    combined.throwIfAborted();
  } catch (error) {
    preparationError = error;
  } finally {
    stop.abort();
    await renewal;
  }
  const failures = [
    ...new Set(
      [
        renewalError,
        preparationError instanceof ResetPreparationError && !renewalError ? undefined : preparationError,
        signal?.aborted ? signal.reason : undefined,
      ].filter((error) => error !== undefined),
    ),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, '초기화 준비와 실행권 갱신 실패');
  const value = Object.freeze({
    eventId: event.id,
    binding: eventBinding(event),
    candidate,
    rejection: preparationError instanceof ResetPreparationError ? resourceRejection(preparationError) : null,
  });
  trusted.add(value);
  return value;
}

export function checkedAdminResetResult(world: World, event: Event) {
  checkAdminEndOrigin(world, checkReplayOrigin, hashState);
  if (
    event.worldId !== world.id ||
    event.kind !== ADMIN_RESET_KIND ||
    event.status !== 'APPLIED' ||
    event.stepTick !== null
  )
    throw new Error('초기화 종료 입력의 출처가 다릅니다.');
  validateAdminResetRecord(
    {
      sequence: event.sequence!,
      tick: event.tick,
      generalId: event.generalId,
      kind: event.kind,
      status: event.status,
      payload: event.payload,
      result: event.result,
    },
    world.id,
  );
  const applied = adminResetAppliedSchema.parse(event.result);
  if (
    world.status !== 'ENDED' ||
    world.endedAt?.toISOString() !== applied.at ||
    world.clockTick !== applied.after.tick ||
    world.clockRevision !== applied.after.revision ||
    world.actionSequence < event.sequence! ||
    world.initialStateHash !== applied.sourceInitialHash ||
    resetSourceSettingsHash(world) !== applied.sourceSettingsHash ||
    (world.replayOrigin as { resourceHash?: unknown } | null)?.resourceHash !== applied.sourceResourceHash ||
    hashState(resetSettingsReference(world)) !== hashState(applied.settings)
  )
    throw new Error('원본 월드와 초기화 종료 기록이 다릅니다.');
  return applied;
}
export function checkedResetTarget(source: World, event: Event, target: World) {
  const result = checkedAdminResetResult(source, event);
  checkAdminEndOrigin(target, checkReplayOrigin, hashState);
  if (
    target.id !== result.newWorldId ||
    target.seed !== result.effectiveSeed ||
    target.initialStateHash !== result.newInitialHash ||
    (target.replayOrigin as { resourceHash?: unknown } | null)?.resourceHash !== result.newResourceHash ||
    resetSourceSettingsHash(target) !== result.newSettingsHash ||
    hashState(resetSettingsReference(target)) !== hashState(result.settings)
  )
    throw new Error('새 월드와 초기화 원본의 연결 기록이 다릅니다.');
  return result;
}

/** Caller holds lease→World and finishes with abort/fence checks in the same 30s TX. */
export async function processAdminReset(
  tx: Prisma.TransactionClient,
  world: World,
  event: Event,
  preparation?: PendingResetPreparation,
  signal?: AbortSignal,
): Promise<{ status: World['status']; tick: number; deferred?: boolean; resetEvent?: Event }> {
  signal?.throwIfAborted();
  const payload = pendingPayload(event);
  if (!Number.isSafeInteger(world.actionSequence) || world.actionSequence < 0 || world.actionSequence >= 2_147_483_647)
    throw new Error('초기화 기록 순번의 저장 범위를 넘었습니다.');
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${event.userId} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: event.userId }, select: { status: true, role: true } }),
    now = await databaseNow(tx);
  let code: AdminResetRejectCode | undefined;
  if (!actor || actor.status !== 'ACTIVE') code = 'ACTOR_INACTIVE';
  else if (actor.role !== 'ADMIN') code = 'ADMIN_REQUIRED';
  else if (
    await tx.sanction.findFirst({
      where: {
        userId: event.userId,
        worldId: null,
        liftedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    })
  )
    code = 'ACTOR_SANCTIONED';
  else {
    try {
      checkAdminEndOrigin(world, checkReplayOrigin, hashState);
    } catch {
      code = 'UNSUPPORTED_FORMAT';
    }
    if (!code) {
      if (world.status !== 'PAUSED') code = 'WORLD_STATE_CHANGED';
      else if (world.name !== payload.intent.confirmName) code = 'WORLD_NAME_CHANGED';
      else if (world.clockRevision !== payload.intent.expectedRevision) code = 'WORLD_REVISION_CHANGED';
      else if (
        world.endedAt ||
        (await tx.worldResult.findUnique({ where: { worldId: world.id }, select: { worldId: true } }))
      )
        code = 'WORLD_RESULT_EXISTS';
      else if (await tx.world.findUnique({ where: { id: payload.plannedNewWorldId }, select: { id: true } }))
        code = 'TARGET_EXISTS';
    }
  }
  if (!code) {
    if (
      !preparation ||
      !trusted.has(preparation) ||
      preparation.eventId !== event.id ||
      preparation.binding !== eventBinding(event)
    )
      return { status: world.status, tick: world.clockTick, deferred: true, resetEvent: event };
    code = preparation.rejection ?? undefined;
    if (!code) {
      if (!preparation.candidate) throw new Error('초기화 준비 후보가 없습니다.');
      try {
        await verifyResetPreparation(
          tx,
          world,
          preparation.candidate,
          payload.effectiveSeed,
          signal ?? new AbortController().signal,
        );
      } catch (error) {
        if (!(error instanceof ResetPreparationError)) throw error;
        code = resourceRejection(error);
      }
    }
  }
  signal?.throwIfAborted();
  let result: Prisma.InputJsonValue;
  if (code) result = { code, message: adminResetRejectMessages[code] };
  else {
    const candidate = preparation!.candidate!,
      finalStateHash = hashState(await loadReplayState(tx, world.id));
    signal?.throwIfAborted();
    const saved = await savePreparedInitialWorld(tx, candidate.prepared, payload.plannedNewWorldId);
    const target = await tx.world.findUniqueOrThrow({ where: { id: saved.worldId } });
    if (
      saved.worldId !== payload.plannedNewWorldId ||
      saved.stateHash !== candidate.evidence.initialHash ||
      target.seed !== payload.effectiveSeed ||
      target.status !== 'PREOPEN' ||
      target.clockTick !== 0 ||
      target.clockRevision !== 0 ||
      target.startedAt !== null ||
      target.endedAt !== null ||
      target.initialStateHash !== saved.stateHash
    )
      throw new Error('새 초기 월드와 준비 후보가 다릅니다.');
    result = adminResetAppliedSchema.parse({
      version: 1,
      sourceWorldId: world.id,
      newWorldId: target.id,
      effectiveSeed: payload.effectiveSeed,
      before: { status: 'PAUSED', tick: world.clockTick, revision: world.clockRevision },
      after: { status: 'ENDED', tick: world.clockTick, revision: world.clockRevision + 1 },
      at: now.toISOString(),
      finalStateHash,
      sourceInitialHash: candidate.evidence.sourceInitialHash,
      sourceResourceHash: candidate.evidence.sourceResourceHash,
      sourceSettingsHash: candidate.evidence.sourceSettingsHash,
      newInitialHash: saved.stateHash,
      newResourceHash: (target.replayOrigin as { resourceHash: unknown }).resourceHash,
      newSettingsHash: resetSourceSettingsHash(target),
      resources: candidate.evidence.resources,
      settings: resetSettingsReference(world),
    });
    const source = await tx.world.updateMany({
      where: { id: world.id, status: 'PAUSED', clockRevision: payload.intent.expectedRevision },
      data: { status: 'ENDED', endedAt: now, clockRevision: { increment: 1 } },
    });
    if (source.count !== 1) throw new Error('원본 월드 상태가 바뀌어 초기화를 취소했습니다.');
  }
  const sequence = await nextActionSequence(tx, world.id),
    status = code ? ('REJECTED' as const) : ('APPLIED' as const);
  validateAdminResetRecord(
    { sequence, tick: world.clockTick, generalId: null, kind: event.kind, status, payload, result },
    world.id,
  );
  const updated = await tx.inputEvent.updateMany({
    where: { id: event.id, status: 'PENDING' },
    data: { status, result, sequence, tick: world.clockTick },
  });
  if (updated.count !== 1) throw new Error('초기화 요청 상태가 바뀌었습니다.');
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: event.userId,
      action: 'world.reset.' + (code ? 'rejected' : 'applied'),
      targetType: 'World',
      targetId: world.id,
      worldId: world.id,
      reason: payload.intent.reason,
      inputEventId: event.id,
      payload: { requestId: String(event.id), sequence, result },
    },
  });
  return { status: code ? world.status : 'ENDED', tick: world.clockTick };
}
