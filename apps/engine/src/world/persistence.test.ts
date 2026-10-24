import type { Prisma, PrismaClient } from '@opensamguk/db';
import { readFileSync } from 'node:fs';
import {
  capsResourceHashInput,
  parseCapsOrigin,
  presetRules,
  type WorldInit,
  type WorldPreset,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { expect, it, vi } from 'vitest';
import { monthlyFixture } from '../../test/monthlyFixture';
import { readCapsArchive } from '../replayCaps';
import { saveInitialWorld } from './persistence';

const preset = JSON.parse(
  readFileSync(new URL('../../../../resources/preset/regular.json', import.meta.url), 'utf8'),
) as WorldPreset;

type Options = Parameters<typeof saveInitialWorld>[2];
const formats = ['default', 'legacy', 'policy'] as const;
function options(format: (typeof formats)[number] = 'default'): Options {
  return {
    name: '생성 단위 월드',
    turnTermMinutes: 30,
    endYear: null,
    ...(format === 'default' ? {} : { replayFormat: format }),
  };
}
function database() {
  const worldId = '00000000-0000-4000-8000-000000000004';
  const createMany = () =>
    vi.fn(async ({ data }: { data: unknown }) => ({ count: Array.isArray(data) ? data.length : 1 }));
  const forbidden = vi.fn(async () => {
    throw new Error('초기 생성에서 허용하지 않은 쓰기입니다.');
  });
  const tx = {
    world: {
      create: vi.fn(async ({ data }: { data: Prisma.WorldCreateInput }) => ({ ...data, id: worldId })),
      update: forbidden,
      updateMany: forbidden,
    },
    nation: { createMany: createMany(), update: vi.fn(async () => ({})) },
    city: { createMany: createMany() },
    general: { createMany: createMany() },
    generalTurn: { createMany: createMany() },
    diplomacy: { createMany: createMany() },
    nationTurn: { createMany: createMany() },
    treaty: { create: forbidden, createMany: forbidden, update: forbidden, updateMany: forbidden },
  };
  const transaction = vi.fn(async (run: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  return { tx, worldId, transaction, forbidden, db: { $transaction: transaction } as unknown as PrismaClient };
}
function initialOrigin(initial: WorldInit) {
  return {
    version: 1,
    initial,
    resourceHash: hashState({
      scenarioKey: initial.scenarioKey,
      mapKey: initial.mapKey,
      unitSetKey: initial.unitSetKey,
      statRules: initial.statRules,
      unitSet: initial.unitSet,
    }),
    initialStateHash: hashState(initial),
  };
}

it.each(formats)('조약 옵션 미지정은 기존 origin1과 %s 정책 생성을 보존한다 (메모리 TX 단위)', async (format) => {
  const initial = await monthlyFixture();
  const original = structuredClone(initial);
  const f = database();
  const result = await saveInitialWorld(f.db, initial, options(format));
  const data = f.tx.world.create.mock.calls[0]![0].data;
  expect(Object.hasOwn(data, 'treatyFormat')).toBe(false);
  expect(JSON.stringify(data.replayOrigin)).toBe(JSON.stringify(initialOrigin(initial)));
  expect(result).toEqual({ worldId: f.worldId, stateHash: hashState(initial) });
  expect(initial).toEqual(original);
  if (format === 'legacy') {
    expect(Object.hasOwn(data, 'policyFromSequence')).toBe(false);
    expect(f.tx.generalTurn.createMany).not.toHaveBeenCalled();
  } else {
    expect(data.policyFromSequence).toBe(0);
    expect(f.tx.generalTurn.createMany.mock.calls[0]![0].data).toHaveLength(initial.generals.length * 30);
  }
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 30000 });
});

it.each(formats)('명시 treatyFormat1은 %s 선택과 독립인 실제 origin6를 한 TX에 쓴다 (단위)', async (format) => {
  const initial = await monthlyFixture();
  const original = structuredClone(initial);
  const f = database();
  const result = await saveInitialWorld(f.db, initial, { ...options(format), treatyFormat: 1 });
  const data = f.tx.world.create.mock.calls[0]![0].data;
  const origin = parseCapsOrigin(data.replayOrigin);
  expect(data.treatyFormat).toBe(1);
  expect(origin.capabilities).toEqual({ version: 1, treaty: { version: 1 } });
  expect(origin.initial).toEqual(initial);
  expect(Object.hasOwn(origin.initial, 'treaties')).toBe(false);
  expect(origin.initialStateHash).toBe(hashState(origin.initial));
  expect(data.initialStateHash).toBe(origin.initialStateHash);
  expect(result).toEqual({ worldId: f.worldId, stateHash: origin.initialStateHash });
  expect(origin.resourceHash).toBe(hashState(capsResourceHashInput(origin)));
  const archive = {
    version: 6,
    origin,
    config: {
      endYear: null,
      outcomeFromSequence: 0,
      ...(format === 'legacy' ? {} : { policy: { version: 1, fromSequence: 0, turnTermMinutes: 30 } }),
    },
    inputs: [],
    months: [],
    end: null,
    afterEnd: [],
  };
  expect(readCapsArchive(archive)).toEqual(archive);
  expect(initial).toEqual(original);
  expect(f.forbidden).not.toHaveBeenCalled();
  expect(f.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 30000 });
  expect(data.policyFromSequence ?? null).toBe(format === 'legacy' ? null : 0);
  const generalRows = f.tx.general.createMany.mock.calls[0]![0].data as Record<string, unknown>[];
  for (const row of generalRows) {
    expect(row.worldId).toBe(f.worldId);
    expect(Object.hasOwn(row, 'defaultPolicy')).toBe(format !== 'legacy');
  }
});

it('명시 조약 생성도 프리셋 규칙이 든 원문과 자원 해시를 보존한다 (단위)', async () => {
  const initial = await monthlyFixture();
  const f = database();
  const result = await saveInitialWorld(f.db, initial, {
    ...options(),
    treatyFormat: 1,
    preset: { key: 'regular', value: preset as WorldPreset },
  });
  const data = f.tx.world.create.mock.calls[0]![0].data;
  const origin = parseCapsOrigin(data.replayOrigin);
  expect(origin.initial).toEqual({ ...initial, presetRules: presetRules(preset as WorldPreset) });
  expect(result.stateHash).toBe(hashState(origin.initial));
  expect(origin.resourceHash).toBe(hashState(capsResourceHashInput(origin)));
  expect(data.presetKey).toBe('regular');
});

it.each([false, true])(
  '확장 commands가 non-null인 프리셋은 조약 선택=%s에서도 TX 전에 거부한다 (단위)',
  async (treaty) => {
    const initial = await monthlyFixture();
    for (const general of [['fire_attack']]) {
      const f = database();
      await expect(
        saveInitialWorld(f.db, initial, {
          ...options(),
          ...(treaty ? { treatyFormat: 1 as const } : {}),
          preset: { key: 'regular', value: { ...preset, commands: { general, nation: [] } } as WorldPreset },
        }),
      ).rejects.toThrow('확장 명령을 켠 월드');
      expect(f.transaction).not.toHaveBeenCalled();
    }
  },
);

it.each([null, 2, false, '1'])(
  '명시한 잘못된 조약 형식 %s는 기존 월드를 건드리지 않고 TX 전에 거부한다 (단위)',
  async (value) => {
    const f = database();
    await expect(
      saveInitialWorld(f.db, await monthlyFixture(), { ...options(), treatyFormat: value as 1 }),
    ).rejects.toThrow('조약 생성 형식');
    expect(f.transaction).not.toHaveBeenCalled();
  },
);

it('새 조약 초기 원문에 treaties가 있으면 TX 전에 거부한다 (단위)', async () => {
  const initial = await monthlyFixture();
  Object.assign(initial, { treaties: [] });
  const f = database();
  await expect(saveInitialWorld(f.db, initial, { ...options(), treatyFormat: 1 })).rejects.toThrow();
  expect(f.transaction).not.toHaveBeenCalled();
});

it('빈 commands 목록은 기존 resolver의 null 선택대로 조약 생성을 허용한다 (단위)', async () => {
  const f = database();
  await saveInitialWorld(f.db, await monthlyFixture(), {
    ...options(),
    treatyFormat: 1,
    preset: { key: 'regular', value: { ...preset, commands: { general: [], nation: [] } } as WorldPreset },
  });
  expect(f.tx.world.create.mock.calls[0]![0].data.treatyFormat).toBe(1);
  expect(f.transaction).toHaveBeenCalledOnce();
});

it('기존 이름·턴 간격·종료 연도 검증은 조약 생성에서도 유지한다 (단위)', async () => {
  const initial = await monthlyFixture();
  for (const invalid of [{ name: ' ' }, { turnTermMinutes: 0 }, { endYear: initial.startYear - 1 }]) {
    const f = database();
    await expect(saveInitialWorld(f.db, initial, { ...options(), treatyFormat: 1, ...invalid })).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  }
});

it('후속 행 저장 실패는 같은 TX callback 밖으로 전달된다 (단위, DB 롤백 증거 아님)', async () => {
  const f = database();
  f.tx.general.createMany.mockRejectedValueOnce(new Error('장수 저장 실패'));
  await expect(saveInitialWorld(f.db, await monthlyFixture(), { ...options(), treatyFormat: 1 })).rejects.toThrow(
    '장수 저장 실패',
  );
  expect(f.tx.world.create).toHaveBeenCalledOnce();
  expect(f.transaction).toHaveBeenCalledOnce();
  expect(f.forbidden).not.toHaveBeenCalled();
});

it('조약 생성은 TX 대기 중 호출자 입력이 바뀌어도 얼린 origin과 같은 행을 저장한다 (단위)', async () => {
  const initial = await monthlyFixture();
  const original = structuredClone(initial);
  const f = database();
  f.transaction.mockImplementationOnce(async (run) => {
    initial.cities[0]!.population++;
    return run(f.tx as unknown as Prisma.TransactionClient);
  });
  const saved = await saveInitialWorld(f.db, initial, { ...options(), treatyFormat: 1 });
  const origin = parseCapsOrigin(f.tx.world.create.mock.calls[0]![0].data.replayOrigin);
  expect(origin.initial).toEqual(original);
  expect(saved.stateHash).toBe(hashState(original));
  expect(f.tx.city.createMany.mock.calls[0]![0].data).toEqual(
    original.cities.map((city) => ({ ...city, worldId: f.worldId })),
  );
});
