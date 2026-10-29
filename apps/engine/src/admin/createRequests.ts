import type { Prisma, PrismaClient } from '@opensamguk/db';
import { checkRuleFeatures, worldCreateIntentSchema, type WorldCreateRejectCode } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { databaseNow } from '../lease';
import { composeInitialWorld, readInitialResources, loadPreset } from '../world/resources';
import { prepareInitialWorld, savePreparedInitialWorld } from '../world/persistence';

type Request = Prisma.WorldCreateRequestGetPayload<Record<string, never>>;
class CreationRejected extends Error {
  constructor(readonly code: WorldCreateRejectCode) {
    super(code);
  }
}
function resourceFailure(error: unknown): never {
  // 접속·DB 오류는 재시도할 PENDING으로 남기고 확정 자료 오류와 구분한다.
  if (
    error instanceof Error &&
    (/^Prisma/.test(error.name) ||
      ('code' in error && typeof error.code === 'string' && /^(P\d{4}|E[A-Z]+|[0-9A-Z]{5})$/.test(error.code)))
  )
    throw error;
  throw new CreationRejected('RESOURCE_INVALID');
}
async function resolveCreation(db: PrismaClient, request: Request) {
  const parsed = worldCreateIntentSchema.safeParse(request.intent);
  if (
    !parsed.success ||
    request.version !== 1 ||
    hashState(parsed.data) !== request.intentHash ||
    (parsed.data.seed !== null && parsed.data.seed !== request.effectiveSeed)
  )
    throw new CreationRejected('INPUT_INVALID');
  const intent = parsed.data;
  let preset;
  try {
    preset = intent.presetKey === null ? null : await loadPreset(intent.presetKey);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new CreationRejected('RESOURCE_INVALID');
    resourceFailure(error);
  }
  const scenario = intent.scenarioKey ?? preset?.scenario,
    map = intent.mapKey ?? preset?.map;
  const turnTermMinutes = intent.turnTermMinutes ?? preset?.turnTermMinutes;
  if (!scenario || !map || turnTermMinutes === undefined) throw new CreationRejected('INPUT_INVALID');
  const selection = {
    scenario,
    map,
    unitSet: intent.unitSetKey ?? preset?.unitSet ?? 'basic',
    statRules: intent.statRulesKey ?? 'default',
    portraitMap: intent.portraitMapKey ?? 'rtk14-map',
  };
  let resources;
  try {
    resources = await readInitialResources(db, selection);
  } catch (error) {
    resourceFailure(error);
  }
  let state;
  try {
    state = composeInitialWorld(resources, request.effectiveSeed);
  } catch (error) {
    resourceFailure(error);
  }
  let prepared;
  try {
    const combined = [...new Set([...(state.ruleFeatures ?? []), ...(intent.ruleFeatures ?? [])])].sort();
    const ruleFeatures = combined.length ? checkRuleFeatures(combined) : [];
    if (state.ruleFeatures) state.ruleFeatures = ruleFeatures;
    prepared = prepareInitialWorld(state, {
      name: intent.name,
      turnTermMinutes,
      endYear: intent.endYear,
      ruleFeatures,
      ...(preset ? { preset: { key: intent.presetKey!, value: preset } } : {}),
    });
  } catch {
    throw new CreationRejected('INPUT_INVALID');
  }
  const resolution = {
    version: 1,
    selection,
    resources: Object.values(resources).map((resource) => ({
      kind: resource.kind,
      name: resource.name,
      version: resource.version,
      contentHash: resource.contentHash,
    })),
    presetKey: intent.presetKey,
    presetHash: preset ? hashState(preset) : null,
    turnTermMinutes,
    endYear: intent.endYear,
    initialStateHash: prepared.stateHash,
  };
  if (request.resolution !== null && hashState(request.resolution) !== hashState(resolution))
    throw new CreationRejected('RESOURCE_INVALID');
  return { prepared, resolution };
}
async function claim(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "WorldCreateRequest" WHERE id=${id} AND status='PENDING' FOR UPDATE SKIP LOCKED`;
  if (rows.length === 0) return null;
  return tx.worldCreateRequest.findUniqueOrThrow({ where: { id } });
}
async function currentActor(tx: Prisma.TransactionClient, requestedBy: string): Promise<WorldCreateRejectCode | null> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${requestedBy} FOR SHARE`;
  const actor = await tx.user.findUnique({ where: { id: requestedBy }, select: { status: true, role: true } });
  if (!actor || actor.status !== 'ACTIVE') return 'ACTOR_INACTIVE';
  if (actor.role !== 'ADMIN') return 'ADMIN_REQUIRED';
  const now = await databaseNow(tx);
  if (
    await tx.sanction.findFirst({
      where: {
        userId: requestedBy,
        worldId: null,
        liftedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    })
  )
    return 'ACTOR_SANCTIONED';
  return null;
}
async function reject(tx: Prisma.TransactionClient, request: Request, code: WorldCreateRejectCode) {
  const now = await databaseNow(tx);
  await tx.worldCreateRequest.update({
    where: { id: request.id },
    data: { status: 'FAILED', errorCode: code, processedAt: now },
  });
  await tx.auditLog.create({
    data: {
      actorKind: 'ADMIN',
      actorUserId: request.requestedBy,
      action: 'world.create.rejected',
      targetType: 'WorldCreateRequest',
      targetId: request.id,
      payload: { requestId: request.id, code },
    },
  });
}
async function rejectRequest(db: PrismaClient, id: string, code: WorldCreateRejectCode, signal: AbortSignal) {
  signal.throwIfAborted();
  return db.$transaction(
    async (tx) => {
      const current = await claim(tx, id);
      if (!current) return false;
      const rejection = (await currentActor(tx, current.requestedBy)) ?? code;
      signal.throwIfAborted();
      await reject(tx, current, rejection);
      signal.throwIfAborted();
      return true;
    },
    { timeout: 30_000 },
  );
}
export async function processWorldCreateRequest(db: PrismaClient, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const candidate = await db.worldCreateRequest.findFirst({
    where: { status: 'PENDING' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (!candidate) return false;
  let resolved: Awaited<ReturnType<typeof resolveCreation>>;
  try {
    resolved = await resolveCreation(db, candidate);
  } catch (error) {
    if (!(error instanceof CreationRejected)) throw error;
    return rejectRequest(db, candidate.id, error.code, signal);
  }
  signal.throwIfAborted();
  let pinned;
  try {
    pinned = await db.$transaction(
      async (tx) => {
        const current = await claim(tx, candidate.id);
        if (!current) return false;
        if (
          current.intentHash !== candidate.intentHash ||
          current.effectiveSeed !== candidate.effectiveSeed ||
          current.plannedWorldId !== candidate.plannedWorldId
        )
          throw new Error('생성 요청의 고정 자료가 바뀌었습니다.');
        if (current.resolution !== null && hashState(current.resolution) !== hashState(resolved.resolution))
          throw new CreationRejected('RESOURCE_INVALID');
        signal.throwIfAborted();
        if (current.resolution === null)
          await tx.worldCreateRequest.update({ where: { id: current.id }, data: { resolution: resolved.resolution } });
        return true;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (error instanceof CreationRejected) return rejectRequest(db, candidate.id, error.code, signal);
    throw error;
  }
  if (!pinned) return false;
  signal.throwIfAborted();
  try {
    return await db.$transaction(
      async (tx) => {
        const current = await claim(tx, candidate.id);
        if (!current) return false;
        if (
          current.intentHash !== candidate.intentHash ||
          current.plannedWorldId !== candidate.plannedWorldId ||
          current.effectiveSeed !== candidate.effectiveSeed ||
          hashState(current.resolution) !== hashState(resolved.resolution)
        )
          throw new Error('생성 요청의 고정 자료가 바뀌었습니다.');
        const code = await currentActor(tx, current.requestedBy);
        signal.throwIfAborted();
        if (code) {
          await reject(tx, current, code);
          signal.throwIfAborted();
          return true;
        }
        const saved = await savePreparedInitialWorld(tx, resolved.prepared, current.plannedWorldId);
        const now = await databaseNow(tx);
        await tx.worldCreateRequest.update({
          where: { id: current.id },
          data: { status: 'DONE', worldId: saved.worldId, processedAt: now },
        });
        await tx.auditLog.create({
          data: {
            actorKind: 'ADMIN',
            actorUserId: current.requestedBy,
            action: 'world.create.applied',
            targetType: 'World',
            targetId: saved.worldId,
            worldId: saved.worldId,
            payload: { requestId: current.id, idempotencyKey: current.idempotencyKey, stateHash: saved.stateHash },
          },
        });
        signal.throwIfAborted();
        return true;
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    // 응답이 유실돼도 이미 확정된 요청을 새 월드로 다시 만들지 않는다.
    const current = await db.worldCreateRequest.findUnique({
      where: { id: candidate.id },
      select: { status: true, worldId: true },
    });
    if (current?.status === 'DONE' && current.worldId === candidate.plannedWorldId) return true;
    throw error;
  }
}
