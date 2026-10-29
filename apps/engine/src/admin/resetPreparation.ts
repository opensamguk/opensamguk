import type { Prisma, PrismaClient, PublishedResource } from '@opensamguk/db';
import {
  checkReplayOrigin,
  parsePreset,
  presetRules,
  statRulesSchema,
  worldCreateIntentSchema,
  ADMIN_RESET_KIND,
  adminResetPayloadSchema,
  adminResetAppliedSchema,
  adminResetSettingsSchema,
  adminResetResourcesSchema,
  validateAdminResetRecord,
  type ReplayOriginV3,
  type WorldInit,
  type WorldPreset,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { z } from 'zod';
import { checkWorldReplay } from '../features';
import { resourceHashV3 } from '../replay';
import { composeInitialWorld, type InitialResources } from '../world/resources';
import { prepareInitialWorld, type PreparedInitialWorld, type InitialWorldOptions } from '../world/persistence';

const messages = {
  UNSUPPORTED_FORMAT: '이 월드의 초기화 준비 형식은 아직 지원하지 않습니다.',
  WORLD_NOT_FOUND: '원본 월드를 찾을 수 없습니다.',
  ORIGIN_INVALID: '원본 생성 기록과 저장 설정이 다릅니다.',
  PROVENANCE_INVALID: '원본 생성 요청의 고정 자료가 다릅니다.',
  RESOURCE_INVALID: '원본 생성 자원을 확인하지 못했습니다.',
  RESOURCE_AMBIGUOUS: '서로 다른 원본 생성 자원이 함께 일치합니다.',
  INPUT_INVALID: '새 시드를 확인하세요.',
} as const;
export class ResetPreparationError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
function fail(code: keyof typeof messages): never {
  throw new ResetPreparationError(code);
}
const key = z.string().regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seed = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('\u0000') &&
      Array.from(value).every((c) => c.length === 2 || c.charCodeAt(0) < 0xd800 || c.charCodeAt(0) > 0xdfff),
  );
const selectionSchema = z.strictObject({ scenario: key, map: key, unitSet: key, statRules: key, portraitMap: key });
const referenceSchema = z.strictObject({
  kind: z.enum(['MAP', 'SCENARIO', 'UNIT_SET', 'STAT_RULES', 'PORTRAIT_MAP']),
  name: key,
  version: z.literal(1),
  contentHash: hash,
});
const resolutionSchema = z.strictObject({
  version: z.literal(1),
  selection: selectionSchema,
  resources: z.array(referenceSchema).length(5),
  presetKey: key.nullable(),
  presetHash: hash.nullable(),
  turnTermMinutes: z.number().int().min(1).max(2_147_483_647),
  endYear: z.number().int().min(1).max(10000).nullable(),
  initialStateHash: hash,
});
const slots = {
  map: 'MAP',
  scenario: 'SCENARIO',
  unitSet: 'UNIT_SET',
  statRules: 'STAT_RULES',
  portraitMap: 'PORTRAIT_MAP',
} as const;
type Selection = z.infer<typeof selectionSchema>;
type Reference = z.infer<typeof referenceSchema>;
type SourceWorld = Prisma.WorldGetPayload<Record<string, never>>;
type Request = Prisma.WorldCreateRequestGetPayload<Record<string, never>>;
type ResetEvent = Prisma.InputEventGetPayload<Record<string, never>>;
export interface ResetPreparationEvidence {
  version: 1;
  sourceWorldId: string;
  sourceSeed: string;
  effectiveSeed: string;
  sourceInitialHash: string;
  initialHash: string;
  sourceResourceHash: string;
  sourceSettingsHash: string;
  provenance: { kind: 'request'; requestId: string } | { kind: 'reset'; requestId: string } | { kind: 'cli' };
  provenanceFingerprint: string;
  resources: readonly Reference[];
}
export interface ResetPreparation {
  readonly prepared: PreparedInitialWorld;
  readonly evidence: Readonly<ResetPreparationEvidence>;
}
const trustedPreparations = new WeakMap<
  ResetPreparation,
  { prepared: PreparedInitialWorld; evidence: Readonly<ResetPreparationEvidence> }
>();
function same(a: unknown, b: unknown) {
  return hashState(a) === hashState(b);
}
function fixed<T>(code: keyof typeof messages, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ResetPreparationError) throw error;
    return fail(code);
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sourceOrigin(world: SourceWorld): {
  origin: ReplayOriginV3;
  preset: WorldPreset | null;
  options: InitialWorldOptions;
} {
  if (world.replayFormat !== 3) fail('UNSUPPORTED_FORMAT');
  return fixed('ORIGIN_INVALID', () => {
    checkReplayOrigin(world.replayOrigin);
    checkWorldReplay(world);
    const origin = world.replayOrigin as unknown as ReplayOriginV3,
      initial = origin.initial;
    if (
      origin.version !== 3 ||
      !hash.safeParse(origin.initialStateHash).success ||
      !hash.safeParse(origin.resourceHash).success ||
      origin.initialStateHash !== hashState(initial) ||
      origin.resourceHash !== resourceHashV3(origin) ||
      world.initialStateHash !== origin.initialStateHash ||
      world.seed !== initial.seed ||
      world.scenarioKey !== initial.scenarioKey ||
      world.mapKey !== initial.mapKey ||
      world.unitSetKey !== initial.unitSetKey ||
      world.startYear !== initial.startYear ||
      !same(world.statRules, initial.statRules) ||
      !same(world.unitSet, initial.unitSet) ||
      !same(world.operationalMap, initial.operationalMap ?? null) ||
      !same(world.commandMeta, initial.commandMeta ?? null) ||
      !Array.isArray(initial.generals) ||
      initial.generals.some((g) => g.userId !== null) ||
      !seed.safeParse(world.seed).success ||
      typeof world.name !== 'string' ||
      !world.name.trim() ||
      (world.presetKey === null) !== (world.preset === null)
    )
      fail('ORIGIN_INVALID');
    const preset = world.preset === null ? null : parsePreset(world.preset);
    if (preset && (!key.safeParse(world.presetKey).success || !same(preset, world.preset))) fail('ORIGIN_INVALID');
    if (!same(initial.presetRules ?? null, preset ? presetRules(preset) : null)) fail('ORIGIN_INVALID');
    const options: InitialWorldOptions = {
      name: world.name,
      turnTermMinutes: world.turnTermMinutes,
      endYear: world.endYear,
      replayFormat: 3,
      ruleFeatures: [...world.ruleFeatures],
      ...(origin.featureData === undefined ? {} : { featureData: structuredClone(origin.featureData) }),
      ...(preset ? { preset: { key: world.presetKey!, value: structuredClone(preset) } } : {}),
    };
    return { origin: structuredClone(origin), preset, options };
  });
}
/** Same C hash recipe; source must be read from the caller's locked World row for apply verification. */
export function resetSourceSettingsHash(world: SourceWorld): string {
  return hashState({
    name: world.name,
    seed: world.seed,
    scenario: world.scenarioKey,
    map: world.mapKey,
    unitSet: world.unitSetKey,
    presetKey: world.presetKey,
    preset: world.preset,
    turnTermMinutes: world.turnTermMinutes,
    endYear: world.endYear,
    ruleFeatures: world.ruleFeatures,
    origin: world.replayOrigin,
  });
}
export function resetSettingsReference(world: SourceWorld) {
  const origin = world.replayOrigin as unknown as ReplayOriginV3;
  return adminResetSettingsSchema.parse({
    name: world.name,
    scenarioKey: world.scenarioKey,
    mapKey: world.mapKey,
    unitSetKey: world.unitSetKey,
    presetKey: world.presetKey,
    presetHash: world.preset === null ? null : hashState(world.preset),
    turnTermMinutes: world.turnTermMinutes,
    endYear: world.endYear,
    ruleFeatures: world.ruleFeatures,
    featureDataHash: hashState(origin.featureData ?? null),
  });
}
function resetRefs(world: SourceWorld, event: ResetEvent): Reference[] {
  return fixed('PROVENANCE_INVALID', () => {
    validateAdminResetRecord(
      {
        sequence: event.sequence!,
        tick: event.tick,
        generalId: event.generalId,
        kind: event.kind,
        status: event.status as 'APPLIED' | 'REJECTED',
        payload: event.payload,
        result: event.result,
      },
      event.worldId,
    );
    const payload = adminResetPayloadSchema.parse(event.payload),
      result = adminResetAppliedSchema.parse(event.result);
    if (
      event.status !== 'APPLIED' ||
      event.id < 1n ||
      !z.uuid().safeParse(event.worldId).success ||
      !z.uuid().safeParse(event.userId).success ||
      !z.uuid().safeParse(event.idempotencyKey).success ||
      event.stepTick !== null ||
      payload.plannedNewWorldId !== world.id ||
      result.newWorldId !== world.id ||
      payload.sourceWorldId !== event.worldId ||
      event.worldId === world.id ||
      result.effectiveSeed !== world.seed ||
      result.newInitialHash !== world.initialStateHash ||
      result.newResourceHash !== (world.replayOrigin as unknown as ReplayOriginV3).resourceHash ||
      result.newSettingsHash !== resetSourceSettingsHash(world) ||
      !same(result.settings, resetSettingsReference(world))
    )
      fail('PROVENANCE_INVALID');
    return result.resources;
  });
}
type Provenance =
  | { kind: 'request'; request: Request; refs: Reference[] }
  | { kind: 'reset'; event: ResetEvent; refs: Reference[] }
  | { kind: 'cli' };
async function provenance(
  tx: Prisma.TransactionClient,
  world: SourceWorld,
  preset: WorldPreset | null,
  signal: AbortSignal,
): Promise<Provenance> {
  signal.throwIfAborted();
  const requests = await tx.worldCreateRequest.findMany({
    where: { OR: [{ worldId: world.id }, { plannedWorldId: world.id }] },
    orderBy: { id: 'asc' },
    take: 2,
  });
  signal.throwIfAborted();
  const resets = await tx.inputEvent.findMany({
    where: {
      kind: ADMIN_RESET_KIND,
      OR: [
        { payload: { path: ['plannedNewWorldId'], equals: world.id } },
        { result: { path: ['newWorldId'], equals: world.id } },
      ],
    },
    orderBy: { id: 'asc' },
    take: 2,
  });
  signal.throwIfAborted();
  if (requests.length + resets.length > 1) fail('PROVENANCE_INVALID');
  if (requests[0]) return { kind: 'request', request: requests[0], refs: requestRefs(world, requests[0], preset) };
  if (resets[0]) return { kind: 'reset', event: resets[0], refs: resetRefs(world, resets[0]) };
  return { kind: 'cli' };
}
function provenanceEvidence(
  value: Provenance,
  refs: Reference[],
): Pick<ResetPreparationEvidence, 'provenance' | 'provenanceFingerprint'> {
  return fixed('PROVENANCE_INVALID', () => {
    if (value.kind === 'request') {
      const r = value.request;
      return {
        provenance: { kind: 'request', requestId: r.id },
        provenanceFingerprint: hashState({
          id: r.id,
          requestedBy: r.requestedBy,
          idempotencyKey: r.idempotencyKey,
          version: r.version,
          intentHash: r.intentHash,
          intent: r.intent,
          effectiveSeed: r.effectiveSeed,
          plannedWorldId: r.plannedWorldId,
          status: r.status,
          worldId: r.worldId,
          resolution: r.resolution,
          errorCode: r.errorCode,
          processedAt: r.processedAt!.toISOString(),
        }),
      };
    }
    if (value.kind === 'reset') {
      const r = value.event;
      return {
        provenance: { kind: 'reset', requestId: String(r.id) },
        provenanceFingerprint: hashState({
          id: String(r.id),
          worldId: r.worldId,
          userId: r.userId,
          idempotencyKey: r.idempotencyKey,
          kind: r.kind,
          status: r.status,
          payload: r.payload,
          result: r.result,
          sequence: r.sequence,
          tick: r.tick,
        }),
      };
    }
    return { provenance: { kind: 'cli' }, provenanceFingerprint: hashState(refs) };
  });
}
function selectionRefs(selection: Selection, refs: readonly Reference[]) {
  if (new Set(refs.map((r) => r.kind)).size !== 5) fail('PROVENANCE_INVALID');
  for (const [slot, kind] of Object.entries(slots)) {
    const wanted = selection[slot as keyof Selection],
      r = refs.find((x) => x.kind === kind);
    if (!r || r.name !== wanted) fail('PROVENANCE_INVALID');
  }
}
function requestRefs(world: SourceWorld, request: Request, preset: WorldPreset | null): Reference[] {
  return fixed('PROVENANCE_INVALID', () => {
    const intent = worldCreateIntentSchema.parse(request.intent),
      resolution = resolutionSchema.parse(request.resolution);
    const expected = {
      scenario: intent.scenarioKey ?? preset?.scenario,
      map: intent.mapKey ?? preset?.map,
      unitSet: intent.unitSetKey ?? preset?.unitSet ?? 'basic',
      statRules: intent.statRulesKey ?? 'default',
      portraitMap: intent.portraitMapKey ?? 'rtk14-map',
    };
    if (
      request.status !== 'DONE' ||
      request.version !== 1 ||
      request.worldId !== world.id ||
      request.plannedWorldId !== world.id ||
      request.errorCode !== null ||
      !request.processedAt ||
      !z.uuid().safeParse(request.id).success ||
      !z.uuid().safeParse(request.requestedBy).success ||
      !z.uuid().safeParse(request.idempotencyKey).success ||
      request.intentHash !== hashState(intent) ||
      intent.name !== intent.name.trim() ||
      (intent.ruleFeatures !== null && !same(intent.ruleFeatures, [...intent.ruleFeatures].sort())) ||
      intent.name !== world.name ||
      request.effectiveSeed !== world.seed ||
      (intent.seed !== null && intent.seed !== world.seed) ||
      !same(resolution.selection, expected) ||
      resolution.selection.scenario !== world.scenarioKey ||
      resolution.selection.map !== world.mapKey ||
      resolution.selection.unitSet !== world.unitSetKey ||
      resolution.presetKey !== world.presetKey ||
      intent.presetKey !== world.presetKey ||
      resolution.presetHash !== (preset ? hashState(preset) : null) ||
      resolution.turnTermMinutes !== world.turnTermMinutes ||
      (intent.turnTermMinutes ?? preset?.turnTermMinutes) !== world.turnTermMinutes ||
      resolution.endYear !== world.endYear ||
      intent.endYear !== world.endYear ||
      resolution.initialStateHash !== world.initialStateHash
    )
      fail('PROVENANCE_INVALID');
    selectionRefs(resolution.selection, resolution.resources);
    return resolution.resources;
  });
}
function checkedResource(row: PublishedResource): PublishedResource {
  if (
    !referenceSchema.safeParse({ kind: row.kind, name: row.name, version: row.version, contentHash: row.contentHash })
      .success ||
    hashState(row.content) !== row.contentHash
  )
    fail('RESOURCE_INVALID');
  return structuredClone(row);
}
async function resourcesByRefs(
  tx: Prisma.TransactionClient,
  refs: readonly Reference[],
  signal: AbortSignal,
): Promise<InitialResources> {
  signal.throwIfAborted();
  // DB errors propagate; they are never interpreted as absence of B provenance or a CLI fallback.
  const rows = await tx.gameResource.findMany({
    where: { status: 'PUBLISHED', OR: refs.map(({ kind, name, version }) => ({ kind, name, version })) },
    select: { kind: true, name: true, version: true, content: true, contentHash: true, source: true },
  });
  signal.throwIfAborted();
  const bundle = {} as InitialResources;
  for (const [slot, kind] of Object.entries(slots)) {
    signal.throwIfAborted();
    const ref = refs.find((r) => r.kind === kind),
      matches = rows.filter((r) => r.kind === ref?.kind && r.name === ref.name && r.version === ref.version);
    if (!ref || matches.length !== 1 || matches[0]!.contentHash !== ref.contentHash) fail('RESOURCE_INVALID');
    bundle[slot as keyof InitialResources] = checkedResource(matches[0]!);
  }
  return bundle;
}
function prepared(
  resources: InitialResources,
  original: ReplayOriginV3,
  options: InitialWorldOptions,
  effectiveSeed: string,
  request?: Request,
) {
  return fixed('RESOURCE_INVALID', () => {
    const state: WorldInit = composeInitialWorld(resources, effectiveSeed),
      features = options.ruleFeatures ?? [];
    if (request) {
      const intent = worldCreateIntentSchema.parse(request.intent);
      if (!same([...new Set([...(state.ruleFeatures ?? []), ...(intent.ruleFeatures ?? [])])].sort(), features))
        fail('PROVENANCE_INVALID');
    }
    if (state.generals.some((g) => g.userId !== null) || (state.ruleFeatures ?? []).some((f) => !features.includes(f)))
      fail('RESOURCE_INVALID');
    if (state.ruleFeatures || features.length) state.ruleFeatures = [...features];
    if (resourceHashV3({ ...original, initial: state }) !== original.resourceHash) fail('RESOURCE_INVALID');
    return prepareInitialWorld(state, options);
  });
}
function references(resources: InitialResources): Reference[] {
  return Object.values(resources)
    .map(({ kind, name, version, contentHash }) => referenceSchema.parse({ kind, name, version, contentHash }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}
async function legacyResources(
  tx: Prisma.TransactionClient,
  world: SourceWorld,
  origin: ReplayOriginV3,
  options: InitialWorldOptions,
  signal: AbortSignal,
): Promise<InitialResources> {
  signal.throwIfAborted();
  const rows = await tx.gameResource.findMany({
    where: {
      status: 'PUBLISHED',
      version: 1,
      OR: [
        { kind: 'MAP', name: world.mapKey },
        { kind: 'SCENARIO', name: world.scenarioKey },
        { kind: 'UNIT_SET', name: world.unitSetKey },
        { kind: 'STAT_RULES' },
        { kind: 'PORTRAIT_MAP' },
      ],
    },
    select: { kind: true, name: true, version: true, content: true, contentHash: true, source: true },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }],
  });
  signal.throwIfAborted();
  const verified = rows.map(checkedResource);
  const unique = (kind: PublishedResource['kind'], name: string) => {
    const found = verified.filter((r) => r.kind === kind && r.name === name);
    if (found.length !== 1) fail('RESOURCE_INVALID');
    return found[0]!;
  };
  const base = {
    map: unique('MAP', world.mapKey),
    scenario: unique('SCENARIO', world.scenarioKey),
    unitSet: unique('UNIT_SET', world.unitSetKey),
  };
  const stats = verified.filter(
    (r) =>
      r.kind === 'STAT_RULES' &&
      fixed('RESOURCE_INVALID', () => same(statRulesSchema.parse(r.content).stat, world.statRules)),
  );
  const portraits = verified.filter((r) => r.kind === 'PORTRAIT_MAP'),
    matches = new Map<string, InitialResources>();
  for (const statRules of stats)
    for (const portraitMap of portraits) {
      signal.throwIfAborted();
      const bundle = { ...base, statRules, portraitMap };
      try {
        if (prepared(bundle, origin, options, world.seed).stateHash === origin.initialStateHash) {
          const signature = hashState(references(bundle).map((r) => ({ kind: r.kind, contentHash: r.contentHash })));
          if (!matches.has(signature)) matches.set(signature, bundle);
        }
      } catch (error) {
        if (!(error instanceof ResetPreparationError)) throw error;
      }
    }
  if (matches.size === 0) fail('RESOURCE_INVALID');
  if (matches.size !== 1) fail('RESOURCE_AMBIGUOUS');
  return matches.values().next().value!;
}

/** Read-only C slice. Applying an old-world end/new PREOPEN and its audit belongs to RESET-D. */
export async function prepareWorldReset(
  db: PrismaClient,
  worldId: string,
  effectiveSeed: string,
  signal: AbortSignal,
): Promise<ResetPreparation> {
  if (!seed.safeParse(effectiveSeed).success) fail('INPUT_INVALID');
  signal.throwIfAborted();
  const frozenSeed = effectiveSeed;
  return db.$transaction(
    async (tx) => {
      signal.throwIfAborted();
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      signal.throwIfAborted();
      const world = await tx.world.findUnique({ where: { id: worldId } });
      signal.throwIfAborted();
      if (!world) fail('WORLD_NOT_FOUND');
      const { origin, preset, options } = sourceOrigin(world);
      const pin = await provenance(tx, world, preset, signal),
        request = pin.kind === 'request' ? pin.request : undefined;
      const resources =
        pin.kind !== 'cli'
          ? await resourcesByRefs(tx, pin.refs, signal)
          : await legacyResources(tx, world, origin, options, signal);
      signal.throwIfAborted();
      // Full original-seed preparation is mandatory before the new seed can be prepared.
      if (prepared(resources, origin, options, world.seed, request).stateHash !== origin.initialStateHash)
        fail('RESOURCE_INVALID');
      signal.throwIfAborted();
      const next = prepared(resources, origin, options, frozenSeed, request);
      signal.throwIfAborted();
      const evidence = freeze<ResetPreparationEvidence>({
        version: 1,
        sourceWorldId: world.id,
        sourceSeed: world.seed,
        effectiveSeed: frozenSeed,
        sourceInitialHash: origin.initialStateHash,
        initialHash: next.stateHash,
        sourceResourceHash: origin.resourceHash,
        sourceSettingsHash: resetSourceSettingsHash(world),
        ...provenanceEvidence(pin, references(resources)),
        resources: references(resources),
      });
      const candidate = Object.freeze({ prepared: next, evidence });
      trustedPreparations.set(candidate, { prepared: next, evidence });
      return candidate;
    },
    { isolationLevel: 'RepeatableRead', timeout: 30_000 },
  );
}

/** No nested transaction/composition. Caller holds lease and source World lock in the existing apply TX. */
export async function verifyResetPreparation(
  tx: Prisma.TransactionClient,
  world: SourceWorld,
  candidate: ResetPreparation,
  requestEffectiveSeed: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const trusted = trustedPreparations.get(candidate);
  if (
    !trusted ||
    candidate.prepared !== trusted.prepared ||
    candidate.evidence !== trusted.evidence ||
    candidate.prepared.stateHash !== candidate.evidence.initialHash ||
    !seed.safeParse(requestEffectiveSeed).success ||
    candidate.evidence.effectiveSeed !== requestEffectiveSeed
  )
    fail('PROVENANCE_INVALID');
  const evidence = trusted.evidence;
  const { origin, preset } = sourceOrigin(world);
  const refs = fixed('PROVENANCE_INVALID', () => adminResetResourcesSchema.parse(evidence.resources));
  if (
    refs.find((ref) => ref.kind === 'MAP')?.name !== world.mapKey ||
    refs.find((ref) => ref.kind === 'SCENARIO')?.name !== world.scenarioKey ||
    refs.find((ref) => ref.kind === 'UNIT_SET')?.name !== world.unitSetKey
  )
    fail('PROVENANCE_INVALID');
  if (
    evidence.version !== 1 ||
    evidence.sourceWorldId !== world.id ||
    evidence.sourceSeed !== world.seed ||
    !seed.safeParse(evidence.effectiveSeed).success ||
    !hash.safeParse(evidence.initialHash).success ||
    evidence.sourceInitialHash !== origin.initialStateHash ||
    evidence.sourceResourceHash !== origin.resourceHash ||
    evidence.sourceSettingsHash !== resetSourceSettingsHash(world)
  )
    fail('PROVENANCE_INVALID');
  const pin = await provenance(tx, world, preset, signal),
    current = provenanceEvidence(pin, refs);
  if (
    !same(current.provenance, evidence.provenance) ||
    current.provenanceFingerprint !== evidence.provenanceFingerprint ||
    (pin.kind !== 'cli' &&
      !same(
        [...pin.refs].sort((a, b) => a.kind.localeCompare(b.kind)),
        refs,
      ))
  )
    fail('PROVENANCE_INVALID');
  for (const ref of refs) {
    signal.throwIfAborted();
    await tx.$queryRaw`SELECT id FROM "GameResource" WHERE kind::text=${ref.kind} AND name=${ref.name} AND version=${ref.version} FOR SHARE`;
    signal.throwIfAborted();
  }
  const resources = await resourcesByRefs(tx, refs, signal);
  signal.throwIfAborted();
  if (!same(references(resources), refs)) fail('RESOURCE_INVALID');
}
