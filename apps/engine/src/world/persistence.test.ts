import { providedRuleKeys, providedRuleData, replayResourceHashInput } from '@opensamguk/rules';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { readFileSync } from 'node:fs';
import {
  checkReplayOrigin,
  initialNationLifecycle,
  presetRules,
  type ReplayOriginV3,
  type WorldPreset,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { describe, expect, it, vi } from 'vitest';
import { monthlyFixture as sourceFixture } from '../../test/monthlyFixture';
import { prepareInitialWorld, readWorldState, saveInitialWorld, savePreparedInitialWorld } from './persistence';
import { createWorldFromCli } from '../admin/creation';

// 손으로 만든 장수 세 명은 역사 자원의 성별 원장 대상이 아니다.
async function monthlyFixture() {
  const initial = await sourceFixture();
  initial.scenarioKey = 'engine-storage-fixture';
  return initial;
}

const preset = JSON.parse(
  readFileSync(new URL('../../../../resources/preset/regular.json', import.meta.url), 'utf8'),
) as WorldPreset;

type Options = Parameters<typeof saveInitialWorld>[2];
function options(): Options {
  return {
    name: '생성 단위 월드',
    turnTermMinutes: 30,
    endYear: null,
  };
}

describe('AC-INT-28 상시 제공 규칙의 초기 저장', () => {
  it.each([undefined, 3] as const)('형식 %s는 모든 규칙 자료와 초기 해시를 함께 저장한다', async (replayFormat) => {
    const initial = await monthlyFixture();
    const before = structuredClone(initial);
    const f = database();
    const result = await saveInitialWorld(f.db, initial, {
      ...options(),
      ...(replayFormat === undefined ? {} : { replayFormat }),
    });
    const data = f.tx.world.create.mock.calls[0]![0].data;
    const origin = data.replayOrigin as unknown as ReplayOriginV3;
    expect(data.replayFormat).toBe(3);
    expect(() => checkReplayOrigin(origin)).not.toThrow();
    expect(origin.initial).toEqual(initial);
    expect(origin.initialStateHash).toBe(hashState(initial));
    expect(origin.featureData).toEqual(providedRuleData(initial, 30));
    expect(origin.resourceHash).toBe(hashState(replayResourceHashInput(initial, origin.featureData)));
    expect(result).toEqual({ worldId: f.worldId, stateHash: origin.initialStateHash });
    expect(data).toMatchObject({
      campaignState: { version: 1 },
      cityResourcesState: { version: 1 },
      cityRuinsState: { version: 1 },
    });
    for (const key of [
      'nationStrategyState',
      'preparedTurnsState',
      'nationResearchState',
      'nationLifecycleState',
      'logisticsState',
      'equipmentState',
      'governanceState',
      'lineageState',
      'stratagemCardsState',
    ]) {
      expect(data).toHaveProperty(key);
      expect(data[key as keyof typeof data]).not.toBeNull();
    }
    expect(f.tx.worldExtSlice.create).toHaveBeenCalledExactlyOnceWith({
      data: { worldId: f.worldId, key: 'intel', value: {} },
    });
    expect(f.tx.generalTurn.createMany.mock.calls[0]![0].data).toHaveLength(initial.generals.length * 30);
    expect(data).not.toHaveProperty('policyFromSequence');
    expect(data).not.toHaveProperty('treatyFormat');
    expect(initial).toEqual(before);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 30000 });
  });

  it.each([1, 'legacy', 'policy'] as const)('구판 %s 생성은 TX 전에 거부한다', async (replayFormat) => {
    const f = database();
    await expect(saveInitialWorld(f.db, await monthlyFixture(), { ...options(), replayFormat })).rejects.toThrow(
      '형식 3',
    );
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it.each([{ treatyFormat: 1 as const }, { extFormat: 1 as const }])(
    '별도 선택 %j는 TX 전에 거부한다',
    async (selection) => {
      const f = database();
      await expect(saveInitialWorld(f.db, await monthlyFixture(), { ...options(), ...selection })).rejects.toThrow(
        '별도 기능',
      );
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([null, 2, false, '1'])('잘못된 별도 조약 선택 %j도 TX 전에 거부한다', async (value) => {
    const f = database();
    await expect(
      saveInitialWorld(f.db, await monthlyFixture(), { ...options(), treatyFormat: value as 1 }),
    ).rejects.toThrow('별도 기능');
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'save', 'cli'] as const)('곱셈 병종도 %s 경계에서 기능 선택 없이 준비한다', async (path) => {
    const initial = await monthlyFixture();
    initial.unitSet.coefMode = 'multiply';
    const f = database();
    if (path === 'prepare') expect(() => prepareInitialWorld(initial, options())).not.toThrow();
    else {
      await (path === 'save' ? saveInitialWorld : createWorldFromCli)(f.db, initial, options());
      const origin = f.tx.world.create.mock.calls[0]![0].data.replayOrigin as unknown as ReplayOriginV3;
      expect(() => checkReplayOrigin(origin)).not.toThrow();
    }
    expect(providedRuleKeys).toContain('battle-affinity-v2');
  });

  it('전투 상성에는 별도 초기 자료를 받지 않는다', async () => {
    const f = database();
    await expect(
      saveInitialWorld(f.db, await monthlyFixture(), {
        ...options(),
        featureData: { 'battle-affinity-v2': {} },
      }),
    ).rejects.toThrow('별도 초기 자료');
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('프리셋의 규칙·원문·자원 해시를 보존한다', async () => {
    const initial = await monthlyFixture();
    const f = database();
    const result = await saveInitialWorld(f.db, initial, { ...options(), preset: { key: 'regular', value: preset } });
    const data = f.tx.world.create.mock.calls[0]![0].data;
    const origin = data.replayOrigin as unknown as ReplayOriginV3;
    expect(origin.initial).toEqual({ ...initial, presetRules: presetRules(preset) });
    expect(result.stateHash).toBe(hashState(origin.initial));
    expect(origin.resourceHash).toBe(hashState(replayResourceHashInput(origin.initial, origin.featureData)));
    expect(data.presetKey).toBe('regular');
  });

  it('월드별 명령 선택은 거부한다', async () => {
    const commands = { general: ['fire_attack'], nation: [] };
    const f = database();
    await expect(
      saveInitialWorld(f.db, await monthlyFixture(), {
        ...options(),
        preset: { key: 'regular', value: { ...preset, commands } as WorldPreset },
      }),
    ).rejects.toThrow('월드별 명령 선택');
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('빈 commands 목록은 null로 정규화하여 상시 제공 규칙으로 생성한다', async () => {
    const f = database();
    await saveInitialWorld(f.db, await monthlyFixture(), {
      ...options(),
      preset: { key: 'regular', value: { ...preset, commands: { general: [], nation: [] } } as WorldPreset },
    });
    expect(f.tx.world.create.mock.calls[0]![0].data.preset).toMatchObject({ commands: null });
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it('사람 장수가 이미 있는 생성 원장은 TX 전에 거부한다', async () => {
    const initial = await monthlyFixture();
    initial.generals[0]!.userId = 'initial-person';
    const f = database();
    await expect(saveInitialWorld(f.db, initial, options())).rejects.toThrow('기존 사람 장수');
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { version: 1, turnTermMinutes: 31 },
    { version: 2, turnTermMinutes: 30 },
    null,
    { version: 1, turnTermMinutes: 30, extra: true },
  ])('잘못된 정책 자료 %j는 TX 전에 거부한다', async (policy) => {
    const f = database();
    await expect(
      saveInitialWorld(f.db, await monthlyFixture(), { ...options(), featureData: { policy } }),
    ).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('초기 조약 행과 잘못된 이름·간격·종료 연도는 TX 전에 거부한다', async () => {
    const initial = await monthlyFixture();
    for (const invalid of [{ name: ' ' }, { turnTermMinutes: 0 }, { endYear: initial.startYear - 1 }]) {
      const f = database();
      await expect(saveInitialWorld(f.db, initial, { ...options(), ...invalid })).rejects.toThrow();
      expect(f.transaction).not.toHaveBeenCalled();
    }
    const f = database();
    await expect(saveInitialWorld(f.db, Object.assign(initial, { treaties: [] }), options())).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('후속 장수 저장 실패는 같은 TX 밖으로 전파한다', async () => {
    const f = database();
    f.tx.general.createMany.mockRejectedValueOnce(new Error('장수 저장 실패'));
    await expect(saveInitialWorld(f.db, await monthlyFixture(), options())).rejects.toThrow('장수 저장 실패');
    expect(f.tx.world.create).toHaveBeenCalledOnce();
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it('TX 대기 중 바뀐 입력을 원생성과 도시 행에 섞지 않는다', async () => {
    const initial = await monthlyFixture();
    const original = structuredClone(initial);
    const f = database();
    f.transaction.mockImplementationOnce(async (run) => {
      initial.cities[0]!.population++;
      return run(f.tx as unknown as Prisma.TransactionClient);
    });
    await saveInitialWorld(f.db, initial, options());
    expect(f.tx.world.create.mock.calls[0]![0].data.replayOrigin).toMatchObject({ initial: original });
    expect(f.tx.city.createMany.mock.calls[0]![0].data).toEqual(
      original.cities.map((city) => ({ ...city, worldId: f.worldId })),
    );
  });
});
function database() {
  const worldId = '00000000-0000-4000-8000-000000000004';
  const createMany = () =>
    vi.fn(async ({ data }: { data: unknown }) => ({ count: Array.isArray(data) ? data.length : 1 }));
  const forbidden = vi.fn(async () => {
    throw new Error('초기 생성에서 허용하지 않은 쓰기입니다.');
  });
  const tx = {
    auditLog: { create: vi.fn(async () => ({})) },
    worldExtSlice: { create: vi.fn(async () => ({})) },
    world: {
      create: vi.fn(async ({ data }: { data: Prisma.WorldCreateInput }) => ({
        ...data,
        id: worldId,
        createdAt: new Date(0),
      })),
      update: forbidden,
      updateMany: forbidden,
    },
    nation: { createMany: createMany(), update: vi.fn(async () => ({})) },
    city: { createMany: createMany() },
    general: { createMany: createMany() },
    generalTurn: { createMany: createMany() },
    diplomacy: { createMany: createMany() },
    nationTurn: { createMany: createMany() },
    publicMapSnapshot: { create: vi.fn(async () => ({})) },
    treaty: { create: forbidden, createMany: forbidden, update: forbidden, updateMany: forbidden },
  };
  const transaction = vi.fn(async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  return { tx, worldId, transaction, forbidden, db: { $transaction: transaction } as unknown as PrismaClient };
}

it('준비한 자료는 입력과 옵션의 후속 변경을 보존된 해시에 섞지 않는다', async () => {
  const initial = await monthlyFixture(),
    original = structuredClone(initial),
    selected = options();
  const prepared = prepareInitialWorld(initial, selected);
  initial.cities[0]!.population++;
  selected.name = '뒤늦은 이름';
  selected.turnTermMinutes = 99;
  const f = database();
  const result = await savePreparedInitialWorld(f.tx as unknown as Prisma.TransactionClient, prepared);
  expect(result).toEqual({ worldId: f.worldId, stateHash: hashState(original) });
  expect(f.tx.world.create.mock.calls[0]![0].data).toMatchObject({
    name: '생성 단위 월드',
    turnTermMinutes: 30,
    replayOrigin: { initial: original, initialStateHash: hashState(original) },
  });
  expect(f.tx.city.createMany.mock.calls[0]![0].data).toEqual(
    original.cities.map((city) => ({ ...city, worldId: f.worldId })),
  );
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(f.transaction).not.toHaveBeenCalled();
  expect(f.tx.auditLog.create).not.toHaveBeenCalled();
});

it('미검증 prepared 복제품은 TX 쓰기 전에 거부하고 예정 UUID는 원본 저장에만 전달한다', async () => {
  const f = database(),
    prepared = prepareInitialWorld(await monthlyFixture(), options());
  await expect(savePreparedInitialWorld(f.tx as unknown as Prisma.TransactionClient, { ...prepared })).rejects.toThrow(
    '검증한 초기 월드',
  );
  expect(f.tx.world.create).not.toHaveBeenCalled();
  const id = '00000000-0000-4000-8000-000000000099';
  await savePreparedInitialWorld(f.tx as unknown as Prisma.TransactionClient, prepared, id);
  expect(f.tx.world.create.mock.calls[0]![0].data.id).toBe(id);
  expect(f.transaction).not.toHaveBeenCalled();
});

it('CLI 원생성은 같은30초 TX에서 저장한 월드 ID·해시로 감사를 쓰고 감사 실패를 전파한다', async () => {
  const initial = await monthlyFixture(),
    f = database();
  const result = await createWorldFromCli(f.db, initial, options());
  expect(f.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 30000 });
  expect(f.tx.auditLog.create).toHaveBeenCalledExactlyOnceWith({
    data: {
      actorKind: 'CLI',
      action: 'world.create.applied',
      targetType: 'World',
      targetId: result.worldId,
      worldId: result.worldId,
      payload: { stateHash: result.stateHash },
    },
  });
  const failure = database();
  failure.tx.auditLog.create.mockRejectedValueOnce(new Error('감사 저장 실패'));
  await expect(createWorldFromCli(failure.db, initial, options())).rejects.toThrow('감사 저장 실패');
  expect(failure.tx.world.create).toHaveBeenCalledOnce();
  expect(failure.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 30000 });
});

it('초기 상태를 읽을 때 기능 목록은 운반하고 활동·거주 열은 공개하지 않는다', async () => {
  const initial = await monthlyFixture();
  const worldId = 'private-initial';
  const world = {
    ...initial,
    id: worldId,
    preset: null,
    replayFormat: 3,

    commandMeta: null,
    runtimeOptions: null,
    nationLifecycleState: initialNationLifecycle(initial.nations),
    replayOrigin: {
      version: 3,
      initial,
      initialStateHash: hashState(initial),
      resourceHash: '',
      featureData: providedRuleData(initial, 30),
    },
  };
  const generalRows = initial.generals.map((general) => ({
    ...general,
    worldId,
    turnRevision: 0,
    battleWins: 0,
    captures: 0,
    noticeSeen: {},
    defaultPolicy: 'none',
    lastActiveTick: null,
    lastActiveAt: null,
    residenceTick: null,
  }));
  const findGenerals = vi.fn(async ({ omit }: { omit: Record<string, boolean> }) =>
    generalRows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !omit[key]))),
  );
  const tx = {
    world: { findUniqueOrThrow: vi.fn().mockResolvedValue(world) },
    $queryRaw: vi.fn().mockResolvedValue([{ key: 'intel', value: {} }]),
    city: { findMany: vi.fn().mockResolvedValue(initial.cities.map((city) => ({ ...city, worldId }))) },
    nation: { findMany: vi.fn().mockResolvedValue(initial.nations.map((nation) => ({ ...nation, worldId }))) },
    general: { findMany: findGenerals },
    diplomacy: { findMany: vi.fn().mockResolvedValue(initial.diplomacies.map((row) => ({ ...row, worldId }))) },
    nationTurn: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const db = {
    $transaction: vi.fn(async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      run(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const state = await readWorldState(db as unknown as PrismaClient, worldId);
  expect(state).toEqual({ ...initial });
  expect(findGenerals.mock.calls[0]![0].omit).toMatchObject({
    defaultPolicy: true,
    lastActiveTick: true,
    lastActiveAt: true,
    residenceTick: true,
  });
});
