import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '../packages/db/src/index';
import {
  applyCapsRecordedInput,
  buildYearbook,
  capsResourceHashInput,
  emptyQueue,
  monthlyDate,
  nextGameAction,
  parseCapsOrigin,
  runCapsReplayAction,
  selectSupportedCapabilities,
  startCapsReplay,
  TICKS_PER_MONTH,
  type CapsOrigin,
  type RecordedInput,
  type WorldInit,
  type WorldPreset,
} from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { engineResolver, verifyWorldExt } from '../apps/engine/src/extState';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { readCapsArchive, replayCapsArchive, exportCapsArchive, type CapsArchive } from '../apps/engine/src/replayCaps';
import { replayArchive } from '../apps/engine/src/replay';
import { worldResolver } from '../apps/server/src/game/resolver';
import { assertEnabledSlots, displaySlots, parseSlot } from '../apps/server/src/game/slots';
import { turnsRouter } from '../apps/server/src/routers/turns';
import { commandsRouter, commandList } from '../apps/server/src/routers/commands';
import { authenticate } from '../apps/server/src/auth/session';
import { createRateLimiter } from '../apps/server/src/security/rateLimit';
import type { Context } from '../apps/server/src/context';

const fixed = JSON.parse(
  readFileSync(new URL('../apps/engine/test/fixtures/ext-fire-5bd54b2.json', import.meta.url), 'utf8'),
) as {
  preset: WorldPreset;
  actor: { generalId: number; tick: number };
  cases: Record<
    string,
    { initial: WorldInit; command: { commandKey: string; args: { cityKey: number }; explicit: true } }
  >;
};
const initial = fixed.cases.successWithInjury!.initial;
const preset = fixed.preset;
function origin(state = initial, value = preset): CapsOrigin {
  const result: CapsOrigin = {
    version: 6,
    initial: structuredClone(state),
    initialStateHash: hashState(state),
    resourceHash: '',
    capabilities: {
      version: 1,
      ext: { version: 1, commands: value.commands!, preset: value, resources: {}, sliceKeys: [] },
    },
  };
  result.resourceHash = hashState(capsResourceHashInput(result));
  return result;
}
function world() {
  return {
    id: 'unit-ext',
    preset,
    replayOrigin: origin(),
    initialStateHash: hashState(initial),
    treatyFormat: null,
    personnelFormat: null,
    policyFromSequence: 0,
    actionSequence: 0,
    turnTermMinutes: 60,
    endYear: null,
    outcomeFromSequence: 0,
    status: 'RUNNING',
    startYear: initial.startYear,
    unitSet: initial.unitSet,
    commandMeta: null,
    clockTick: 0,
  };
}
function creationDb() {
  const createMany = () => vi.fn().mockResolvedValue({ count: 1 });
  const tx = {
    world: { create: vi.fn(async ({ data }: { data: Prisma.WorldCreateInput }) => ({ id: 'unit-ext', ...data })) },
    nation: { createMany: createMany(), update: vi.fn().mockResolvedValue({}) },
    city: { createMany: createMany() },
    general: { createMany: createMany() },
    generalTurn: { createMany: createMany() },
    diplomacy: { createMany: createMany() },
    nationTurn: { createMany: createMany() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockRejectedValue(new Error('조각 쓰기를 허용하지 않습니다.')),
  };
  const transaction = vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  return { db: { $transaction: transaction } as unknown as PrismaClient, tx, transaction };
}

it('명시 opt-in 생성은 정규 descriptor와 초기 해시를 쓰고 상태 조각은 만들지 않는다', async () => {
  const f = creationDb();
  const unsorted = { ...preset, commands: { general: ['sabotage', 'fire_attack'], nation: [] } };
  const original = structuredClone(unsorted);
  const result = await saveInitialWorld(f.db, initial, {
    name: '단위 확장',
    turnTermMinutes: 60,
    endYear: null,
    extFormat: 1,
    preset: { key: 'unit-ext', value: unsorted },
  });
  const data = f.tx.world.create.mock.calls[0]![0].data;
  const parsed = parseCapsOrigin(data.replayOrigin);
  expect(parsed.capabilities.ext).toMatchObject({
    version: 1,
    commands: { general: ['fire_attack', 'sabotage'], nation: [] },
    resources: {},
    sliceKeys: [],
  });
  expect(Object.hasOwn(parsed.initial, 'ext')).toBe(false);
  expect(data.initialStateHash).toBe(hashState(parsed.initial));
  expect(result.stateHash).toBe(data.initialStateHash);
  expect(parsed.resourceHash).toBe(hashState(capsResourceHashInput(parsed)));
  const stored = { ...world(), ...data, preset: data.preset, replayOrigin: parsed };
  expect(engineResolver(stored).resolver.get('fire_attack')?.name).toBe('화계');
  expect(worldResolver(stored).commands?.general).toEqual(['fire_attack', 'sabotage']);
  expect(data.policyFromSequence).toBe(0);
  expect(Object.hasOwn(data, 'treatyFormat')).toBe(false);
  expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  expect(unsorted).toEqual(original);
});

it('opt-in 누락·조합·형식·초기 조각 오류는 생성 TX 전에 거부한다', async () => {
  const options = {
    name: '단위 확장',
    turnTermMinutes: 60,
    endYear: null,
    extFormat: 1 as const,
    preset: { key: 'ext', value: preset },
  };
  for (const change of [
    { extFormat: undefined },
    { treatyFormat: 1 },
    { replayFormat: 'legacy' },
    { preset: undefined },
    { extFormat: 2 },
  ]) {
    const f = creationDb();
    await expect(
      saveInitialWorld(f.db, initial, { ...options, ...change } as Parameters<typeof saveInitialWorld>[2]),
    ).rejects.toThrow();
    expect(f.transaction).not.toHaveBeenCalled();
  }
  const f = creationDb();
  await expect(saveInitialWorld(f.db, { ...initial, ext: {} }, options)).rejects.toThrow();
  expect(f.transaction).not.toHaveBeenCalled();
});

it('엔진과 서버 adapter는 D2·D3·D7 불일치를 같은 경계에서 거부한다', async () => {
  const row = world();
  expect(engineResolver(row).commands).toEqual(preset.commands);
  expect(worldResolver(row).commands).toEqual(preset.commands);
  const invalid = [
    { ...row, preset: { ...preset, commands: null } },
    { ...row, preset: { ...preset, commands: { general: ['incite'], nation: [] } } },
    { ...row, preset: { ...preset, name: '다른 프리셋' } },
    { ...row, replayOrigin: { version: 1 } },
    { ...row, policyFromSequence: null },
    { ...row, personnelFormat: 1 },
  ];
  for (const value of invalid) {
    expect(() => engineResolver(value)).toThrow();
    expect(() => worldResolver(value)).toThrow();
    const tx = { $queryRaw: vi.fn() };
    await expect(verifyWorldExt(tx as unknown as Prisma.TransactionClient, value)).rejects.toThrow();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  }
});

it('끈 목록·파싱은 그대로고 켠 목록만 확장 입력과 표시를 허용한다', () => {
  const turn = { commandKey: 'fire_attack', args: { cityKey: 2 } };
  expect(() => parseSlot(turn)).toThrow('명령과 인자를 확인하세요.');
  const parsed = parseSlot(turn, true);
  expect(() => assertEnabledSlots({ preset: null }, [parsed])).toThrow('명령과 인자를 확인하세요.');
  expect(() => assertEnabledSlots(world(), [parsed])).not.toThrow();
  expect(displaySlots([parsed], worldResolver(world()).resolver)[0]?.name).toBe('화계');
  expect(
    worldResolver({ preset: null })
      .resolver.list('general')
      .map((d) => d.key),
  ).toEqual(commandList.map((d) => d.key));
  expect(() => parseSlot({ ...turn, args: { cityKey: Infinity } }, true)).toThrow();
});

function api(row: unknown = world(), userId: string | null = 'n1-fixture-actor') {
  const general = {
    ...initial.generals.find((value) => value.userId === userId)!,
    turnRevision: 0,
    defaultPolicy: 'none',
    lastActiveTick: null,
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    world: {
      findUnique: vi.fn().mockResolvedValue(row),
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue({ actionSequence: 1 }),
    },
    general: {
      findUnique: vi.fn().mockResolvedValue(general),
      findMany: vi.fn().mockResolvedValue(initial.generals),
      update: vi.fn().mockResolvedValue(general),
    },
    generalTurn: {
      findMany: vi.fn().mockResolvedValue(emptyQueue().map((turn, slot) => ({ ...turn, slot }))),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    inputEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ createdAt: new Date(1000) }),
    },
    city: { findMany: vi.fn().mockResolvedValue(initial.cities) },
    nation: { findMany: vi.fn().mockResolvedValue(initial.nations) },
    diplomacy: { findMany: vi.fn().mockResolvedValue(initial.diplomacies) },
    treaty: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const transaction = vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    run(tx as unknown as Prisma.TransactionClient),
  );
  const ctx = {
    db: { $transaction: transaction, world: tx.world } as unknown as PrismaClient,
    user: userId ? { id: userId, email: 'fixture@example.invalid' } : null,
    rateLimiter: createRateLimiter({ now: () => 1000 }),
    reply: { header: vi.fn() },
  } as unknown as Context;
  return { tx, transaction, ctx, caller: turnsRouter.createCaller(ctx), commands: commandsRouter.createCaller(ctx) };
}
const clientSlots = () => [{ commandKey: 'fire_attack', args: { cityKey: 2 } }, ...Array<null>(29).fill(null)];
const slots = () => [parseSlot({ commandKey: 'fire_attack', args: { cityKey: 2 } }, true), ...emptyQueue().slice(1)];

it('새 예턴을 정규 router로 저장하고 세션의 장수·revision·활동 기록을 쓴다 (메모리 TX)', async () => {
  const f = api();
  const result = await f.caller.set({ worldId: 'unit-ext', revision: 0, slots: clientSlots() });
  expect(result.ok).toBe(true);
  expect(result.slots[0]?.name).toBe('화계');
  expect(f.tx.inputEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ userId: 'n1-fixture-actor', generalId: 1, kind: 'turns.set', status: 'APPLIED' }),
    }),
  );
  expect(f.tx.generalTurn.createMany.mock.calls[0]?.[0].data).toHaveLength(30);
  expect((await f.commands.list({ worldId: 'unit-ext' })).some((d) => d.key === 'fire_attack')).toBe(true);
  expect(await f.caller.precheck({ worldId: 'unit-ext', commandKey: 'fire_attack', args: { cityKey: 2 } })).toEqual({
    ok: true,
  });
  expect(await f.caller.precheck({ worldId: 'unit-ext', commandKey: 'sabotage', args: { cityKey: 2 } })).toMatchObject({
    ok: false,
    code: 'COMMAND_DISABLED',
  });
  await expect(
    f.caller.set({
      worldId: 'unit-ext',
      revision: 0,
      slots: [{ commandKey: 'sabotage', args: { cityKey: 2 } }, ...Array<null>(29).fill(null)],
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '이 월드에서 꺼진 명령입니다.' });
  expect(
    await f.caller.edit({
      worldId: 'unit-ext',
      revision: 0,
      op: { put: { from: 0, to: 1, commandKey: 'fire_attack', args: { cityKey: 2 } } },
    }),
  ).toMatchObject({ ok: true });
});

it('무인증·다른 사용자·잘못된 인자는 procedure로, 제재는 세션 함수로 검사한다 (네트워크 없음)', async () => {
  const unauth = api(world(), null);
  await expect(unauth.caller.set({ worldId: 'unit-ext', revision: 0, slots: clientSlots() })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  expect(unauth.transaction).not.toHaveBeenCalled();
  const sessionDb = {
    session: { findUnique: vi.fn().mockResolvedValue({ expiresAt: new Date(2000), user: { status: 'SANCTIONED' } }) },
  };
  const sanctioned = await authenticate(sessionDb as unknown as PrismaClient, 'fixture-token', 1000, false);
  expect(sanctioned).toBeNull();
  const other = api(world(), 'n1-fixture-defender');
  await other.caller.set({ worldId: 'unit-ext', revision: 0, slots: clientSlots() });
  expect(other.tx.inputEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ userId: 'n1-fixture-defender', generalId: 2 }) }),
  );
  const bad = api();
  await expect(
    bad.caller.set({
      worldId: 'unit-ext',
      revision: 0,
      slots: [{ commandKey: 'fire_attack', args: { cityKey: 0 } }, ...emptyQueue().slice(1)],
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(bad.transaction).not.toHaveBeenCalled();
});

it('끈·없는 월드의 확장 입력은 기존 입력 오류가 종료·방침·장수 오류보다 먼저다', async () => {
  const off = api({
    ...world(),
    preset: null,
    replayOrigin: { version: 1 } as unknown as CapsOrigin,
    status: 'ENDED',
    policyFromSequence: null as unknown as number,
  });
  for (const run of [
    () => off.caller.set({ worldId: 'unit-ext', revision: 0, slots: clientSlots() }),
    () => off.caller.precheck({ worldId: 'unit-ext', commandKey: 'fire_attack', args: { cityKey: 2 } }),
  ])
    await expect(run()).rejects.toMatchObject({ code: 'BAD_REQUEST', message: '명령과 인자를 확인하세요.' });
  expect(off.tx.generalTurn.deleteMany).not.toHaveBeenCalled();
  expect(off.tx.general.findUnique).not.toHaveBeenCalled();
  const absent = api();
  absent.tx.world.findUnique.mockResolvedValue(null);
  await expect(absent.caller.set({ worldId: 'absent', revision: 0, slots: clientSlots() })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: '명령과 인자를 확인하세요.',
  });
});

function archiveFixture(): CapsArchive {
  const source = origin();
  const config = {
    endYear: null,
    outcomeFromSequence: 0,
    policy: { version: 1 as const, fromSequence: 0, turnTermMinutes: 60 },
  };
  const selected = selectSupportedCapabilities(source, config);
  const input: RecordedInput = {
    sequence: 1,
    kind: 'turns.set',
    status: 'APPLIED',
    generalId: 1,
    payload: { turns: slots(), revision: 0 },
    result: { revision: 1, activeTick: 0 },
  };
  // 앱 재생기를 검사한다. 규칙 함수를 따로 순회해 월간 대조값을 만든다.
  let replay = startCapsReplay(source, selected);
  replay = applyCapsRecordedInput(replay, input, { selection: selected });
  const months: CapsArchive['months'] = [];
  let sequence = 1;
  while (months.length < 12) {
    const action = nextGameAction(replay);
    replay = runCapsReplayAction(replay, source.initial.seed, source.initial.unitSet, selected);
    sequence++;
    if (action.kind === 'monthly') {
      const date = monthlyDate(source.initial.startYear, action.tick);
      months.push({
        tick: action.tick,
        year: date.year,
        month: date.month,
        sequence,
        stateHash: hashState(replay),
        data: buildYearbook(replay.state, date.year),
      });
    }
    if (sequence > 10000) throw new Error('고정물의 월간 기록을 만들지 못했습니다.');
  }
  return { version: 6, origin: source, config, inputs: [input], months, end: null, afterEnd: [] };
}

it('앱의 archive6 walker와 공개 재생 dispatcher가 화계 12개월 해시를 재현한다 (순수 adapter 단위)', () => {
  const archive = archiveFixture();
  const expected = archive.months.map(({ tick, stateHash }) => ({ tick, stateHash }));
  expect(replayCapsArchive(archive)).toEqual(expected);
  expect(replayArchive(archive)).toEqual(expected);
  expect(archive.months[0]?.tick).toBe(TICKS_PER_MONTH);
});

it('확장 archive의 R7~R13 위반은 앱 reader가 원문을 바꾸지 않고 거부한다', () => {
  const archive = archiveFixture();
  const invalid = [
    (a: CapsArchive) => {
      a.origin.capabilities.ext!.commands = { general: ['sabotage'], nation: [] };
    },
    (a: CapsArchive) => {
      a.origin.initial.ext = {};
    },
    (a: CapsArchive) => {
      a.origin.resourceHash = 'wrong';
    },
    (a: CapsArchive) => {
      a.inputs[0]!.payload = { bad: NaN };
    },
    (a: CapsArchive) => {
      delete (a as Partial<CapsArchive>).afterEnd;
    },
    (a: CapsArchive) => {
      (a.inputs[0]!.payload as { turns: { commandKey: string }[] }).turns[0]!.commandKey = 'incite';
    },
    (a: CapsArchive) => {
      delete a.origin.initial.presetRules;
    },
  ];
  for (const change of invalid) {
    const value = structuredClone(archive);
    change(value);
    const before = structuredClone(value);
    expect(() => readCapsArchive(value)).toThrow();
    expect(value).toEqual(before);
  }
});

it('실제 수출 adapter는 저장된 정상 선택으로 archive6를 만들고 조약 guard를 보존한다 (메모리 조회)', async () => {
  const archive = archiveFixture();
  const row = world();
  const selected = {
    kind: 'caps' as const,
    origin: archive.origin,
    selection: selectSupportedCapabilities(archive.origin, archive.config),
  };
  const tx = {
    treaty: { findMany: vi.fn().mockResolvedValue([]) },
    yearbookSnapshot: { findMany: vi.fn().mockResolvedValue(archive.months) },
    worldResult: { findUnique: vi.fn().mockResolvedValue(null) },
    inputEvent: { findMany: vi.fn().mockResolvedValue(archive.inputs) },
  };
  expect(
    await exportCapsArchive(
      tx as unknown as Prisma.TransactionClient,
      row as unknown as Prisma.WorldGetPayload<Record<string, never>>,
      selected,
    ),
  ).toEqual(archive);
  expect(tx.treaty.findMany).toHaveBeenCalledOnce();
  tx.treaty.findMany.mockResolvedValue([{ id: 1 }]);
  await expect(
    exportCapsArchive(
      tx as unknown as Prisma.TransactionClient,
      row as unknown as Prisma.WorldGetPayload<Record<string, never>>,
      selected,
    ),
  ).rejects.toThrow('조약을 끈 월드');
});
