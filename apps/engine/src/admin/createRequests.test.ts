import { readFileSync } from 'node:fs';
import type { PrismaClient, PublishedResource } from '@opensamguk/db';
import { worldCreateIntent } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { afterEach, expect, it, vi } from 'vitest';
import * as resources from '../world/resources';
import * as persistence from '../world/persistence';
import { lineageTestConfig } from '@opensamguk/rules/testing/lineage';
import { processWorldCreateRequest } from './createRequests';

afterEach(() => vi.restoreAllMocks());

function sexEditionRequest(frozen: 'old' | 'second' | 'latest' | 'missing' | null, lineage = true) {
  const read = (kind: PublishedResource['kind'], name: string, path: string): PublishedResource => {
    const content = JSON.parse(readFileSync(new URL(`../../../../resources/${path}`, import.meta.url), 'utf8'));
    return { kind, name, version: 1, content, contentHash: hashState(content), source: 'repository fixture' };
  };
  const selected = {
      map: read('MAP', 'che', 'map/che.json'),
      scenario: read('SCENARIO', '1030', 'scenario/1030.json'),
      unitSet: read('UNIT_SET', 'basic', 'unitset/basic.json'),
      statRules: read('STAT_RULES', 'default', 'scenario/default.json'),
      portraitMap: read('PORTRAIT_MAP', 'rtk14-map', 'portraits/rtk14-map.json'),
    },
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
        return { id: request.plannedWorldId };
      }),
    },
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

it.each([
  {
    name: '역사 프리셋',
    input: { presetKey: 'regular' },
    expected: {
      scenario: 'san10-191',
      map: 'san10',
      unitSet: 'expanded',
      statRules: 'five-stats',
      portraitMap: '191-map',
    },
  },
  {
    name: '공백지 프리셋',
    input: { presetKey: 'empty' },
    expected: {
      scenario: 'san10-empty',
      map: 'san10',
      unitSet: 'expanded',
      statRules: 'five-stats',
      portraitMap: '191-map',
    },
  },
  {
    name: 'SAN10 명시 자원',
    input: {
      scenarioKey: 'san10-191',
      mapKey: 'san10',
      statRulesKey: 'default',
      portraitMapKey: 'rtk14-map',
      turnTermMinutes: 30,
    },
    expected: { scenario: 'san10-191', map: 'san10', unitSet: 'basic', statRules: 'default', portraitMap: 'rtk14-map' },
  },
  {
    name: '구판 생략 자원',
    input: { scenarioKey: 'integration191', mapKey: 'integration', turnTermMinutes: 30 },
    expected: {
      scenario: 'integration191',
      map: 'integration',
      unitSet: 'basic',
      statRules: 'default',
      portraitMap: 'rtk14-map',
    },
  },
])('AC-M3-04 $name 생성은 공통 추론 결과로 자원을 읽고 접속 오류를 보존한다', async ({ input, expected }) => {
  const intent = worldCreateIntent({
    expectedUserId: '00000000-0000-4000-8000-000000000001',
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    name: '생성 추론 경계',
    seed: 'create-inference-only',
    endYear: 201,
    ...input,
  });
  const request = {
    id: '00000000-0000-4000-8000-000000000003',
    version: 1,
    intent,
    intentHash: hashState(intent),
    effectiveSeed: intent.seed,
  };
  const before = structuredClone(request),
    transportFailure = Object.assign(new Error('고정 접속 오류'), { code: 'P1001' }),
    read = vi.spyOn(resources, 'readInitialResources').mockRejectedValueOnce(transportFailure),
    transaction = vi.fn(),
    db = {
      worldCreateRequest: { findFirst: vi.fn(async () => request) },
      $transaction: transaction,
    } as unknown as PrismaClient;

  await expect(processWorldCreateRequest(db, new AbortController().signal)).rejects.toBe(transportFailure);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(db, expected);
  expect(transaction).not.toHaveBeenCalled();
  expect(request).toEqual(before);
});
