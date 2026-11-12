import type { PrismaClient } from '../packages/db/src/index';
import { worldCreateIntent } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { afterEach, expect, it, vi } from 'vitest';
import * as resources from '../apps/engine/src/world/resources';
import * as persistence from '../apps/engine/src/world/persistence';
import { lineageTestConfig } from '../packages/rules/src/lineage/testFixture';
import { processWorldCreateRequest } from '../apps/engine/src/admin/createRequests';

import { readInitialResources } from '../apps/engine/src/world/resources';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';

const selectedResources = await (async () => {
  const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
  try {
    return await readInitialResources(db, { map: 'che', scenario: '1030' });
  } finally {
    await db.$disconnect();
  }
})();

afterEach(() => vi.restoreAllMocks());

function sexEditionRequest(frozen: 'old' | 'second' | 'latest' | 'missing' | null, lineage = true) {
  const selected = Object.fromEntries(
      Object.entries(selectedResources).map(([slot, row]) => [slot, { ...row, source: 'repository fixture' }]),
    ) as resources.InitialResources,
    initial = resources.composeInitialWorld(selected, 'sex-request-seed'),
    ruleFeatures = [
      ...new Set([...(initial.ruleFeatures ?? []), 'personnel', 'policy', ...(lineage ? ['lineage-v1'] : [])]),
    ].sort(),
    intent = worldCreateIntent({
      expectedUserId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
      name: '성별 판 고정 생성',
      scenarioKey: '1030',
      mapKey: 'che',
      statRulesKey: 'default',
      portraitMapKey: 'rtk14-map',
      seed: initial.seed,
      turnTermMinutes: 60,
      endYear: null,
      ruleFeatures,
    }),
    realPrepare = persistence.prepareInitialWorld,
    options = {
      name: intent.name,
      turnTermMinutes: 60,
      endYear: null,
      ruleFeatures,
      ...(lineage ? { featureData: { 'lineage-v1': lineageTestConfig } } : {}),
    },
    ledgers = resources.loadSexLedgers(),
    oldHash = realPrepare(initial, options, ledgers[0]).stateHash,
    secondHash = realPrepare(initial, options, ledgers[1]).stateHash,
    latestHash = realPrepare(initial, options).stateHash;
  const resolution = {
    version: 1,
    selection: { scenario: '1030', map: 'che', unitSet: 'basic', statRules: 'default', portraitMap: 'rtk14-map' },
    resources: Object.values(selected).map(({ kind, name, version, contentHash }) => ({
      kind,
      name,
      version,
      contentHash,
    })),
    presetKey: null,
    presetHash: null,
    turnTermMinutes: 60,
    endYear: null,
    initialStateHash:
      frozen === 'old'
        ? oldHash
        : frozen === 'second'
          ? secondHash
          : frozen === 'missing'
            ? '0'.repeat(64)
            : latestHash,
  };
  const request = {
    id: '00000000-0000-4000-8000-000000000003',
    requestedBy: '00000000-0000-4000-8000-000000000001',
    plannedWorldId: '00000000-0000-4000-8000-000000000004',
    version: 1,
    intent,
    intentHash: hashState(intent),
    effectiveSeed: initial.seed,
    resolution: frozen === null ? null : resolution,
    status: 'PENDING',
    errorCode: null,
  };
  let stored: Record<string, unknown> | undefined;
  const createMany = vi.fn(async () => ({ count: 0 }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: request.id, now: new Date(0) }]),
    worldCreateRequest: {
      findUniqueOrThrow: vi.fn(async () => structuredClone(request)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(request, data)),
    },
    user: { findUnique: vi.fn(async () => ({ status: 'ACTIVE', role: 'ADMIN' })) },
    sanction: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    world: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored = data;
        return { id: request.plannedWorldId, createdAt: new Date(0) };
      }),
    },
    publicMapSnapshot: { create: vi.fn(async () => ({})) },
    nation: { createMany, update: vi.fn(async () => ({})) },
    city: { createMany },
    general: { createMany },
    generalTurn: { createMany },
    diplomacy: { createMany },
    nationTurn: { createMany },
  };
  vi.spyOn(resources, 'readInitialResources').mockResolvedValue(selected);
  // 공개 프로필은 아직 가문 설정을 제공하지 않는다. 신뢰한 시험 설정만 실제 생성 함수에 보탠다.
  const prepare = vi
    .spyOn(persistence, 'prepareInitialWorld')
    .mockImplementation((state, settings, ledger) =>
      realPrepare(
        state,
        { ...settings, ...(lineage ? { featureData: { 'lineage-v1': lineageTestConfig } } : {}) },
        ledger,
      ),
    );
  const db = {
    worldCreateRequest: {
      findFirst: vi.fn(async () => structuredClone(request)),
      findUnique: vi.fn(async () => request),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaClient;
  return { db, request, tx, prepare, oldHash, secondHash, latestHash, stored: () => stored };
}

it.each(['old', 'second', 'latest', null] as const)(
  'AC-P2-32 고정된 생성은 %s 성별 판을 유지하고 미고정 생성은 최신 판을 쓴다',
  async (frozen) => {
    const f = sexEditionRequest(frozen),
      before = structuredClone(f.request.resolution),
      all = vi.spyOn(resources, 'loadSexLedgers');
    await expect(processWorldCreateRequest(f.db, new AbortController().signal)).resolves.toBe(true);
    expect(f.request.status).toBe('DONE');
    expect(f.oldHash).not.toBe(f.latestHash);
    expect(f.secondHash).not.toBe(f.latestHash);
    const origin = f.stored()!.replayOrigin as {
      initial: { generals: Array<{ id: number; sex: string }> };
      initialStateHash: string;
    };
    expect(origin.initial.generals.find((g) => g.id === 47)?.sex).toBe(frozen === 'old' ? 'UNKNOWN' : 'MALE');
    expect(origin.initial.generals.find((g) => g.id === 266)?.sex).toBe(
      frozen === 'old' || frozen === 'second' ? 'UNKNOWN' : 'MALE',
    );
    expect(origin.initialStateHash).toBe(
      frozen === 'old' ? f.oldHash : frozen === 'second' ? f.secondHash : f.latestHash,
    );
    if (before) expect(f.request.resolution).toEqual(before);
    if (frozen === null) expect(all).not.toHaveBeenCalled();
  },
);

it.each(['missing', 'tampered'] as const)('AC-P2-32 생성의 %s 고정 해시는 새 판으로 교체하지 않는다', async (kind) => {
  const f = sexEditionRequest(kind === 'missing' ? 'missing' : 'old');
  if (kind === 'tampered') f.request.resolution!.resources[0]!.contentHash = '0'.repeat(64);
  await expect(processWorldCreateRequest(f.db, new AbortController().signal)).resolves.toBe(true);
  expect(f.request).toMatchObject({ status: 'FAILED', errorCode: 'RESOURCE_INVALID' });
  expect(f.tx.world.create).not.toHaveBeenCalled();
});

it.each([null, 'latest'] as const)('AC-P2-32 가문을 끈 %s 생성은 성별 판을 읽지 않는다', async (frozen) => {
  const f = sexEditionRequest(frozen, false),
    all = vi.spyOn(resources, 'loadSexLedgers'),
    latest = vi.spyOn(resources, 'loadSexLedger');
  await processWorldCreateRequest(f.db, new AbortController().signal);
  expect(f.request.status).toBe('DONE');
  expect(all).not.toHaveBeenCalled();
  expect(latest).not.toHaveBeenCalled();
});
