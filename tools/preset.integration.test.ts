import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  initialReplayState,
  enableReplayPolicy,
  presetRules,
  runCommand,
  applyEffects,
  type WorldInit,
  type WorldPreset,
  type QueuedTurn,
} from '../packages/rules/src/index';
import { rngFor } from '../packages/shared/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { buildServer } from '../apps/server/src/server';
import { appRouter } from '../apps/server/src/router';
import { newSession } from '../apps/server/src/auth/session';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { loadPreset, resourceRoot } from '../apps/engine/src/world/resources';
import { saveInitialWorld, readWorldState } from '../apps/engine/src/world/persistence';
import { loadReplayState } from '../apps/engine/src/monthly';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { exportReplay, replayArchive, replayToEnd, type ReplayArchive } from '../apps/engine/src/replay';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname))
  throw new Error('T2-02 전용 테스트 DB가 필요합니다.');
const db = createDb(url);
const origin = 'http://127.0.0.1:5173';
const app = await buildServer({ db, publicOrigin: origin, logging: false });
const root = new URL('../', import.meta.url);
const users = ['preset-actor', 'preset-other', 'preset-new', 'preset-sanctioned'];
const cookies = new Map<string, string>();
let base: string;

beforeAll(async () => {
  await db.world.deleteMany();
  for (const id of users) {
    await db.user.upsert({
      where: { id },
      update: { status: id === 'preset-sanctioned' ? 'SANCTIONED' : 'ACTIVE' },
      create: {
        id,
        email: `${id}@example.invalid`,
        passwordHash: 'fixture-only',
        status: id === 'preset-sanctioned' ? 'SANCTIONED' : 'ACTIVE',
      },
    });
    const session = newSession(Date.now());
    await db.session.create({ data: { id: session.id, userId: id, expiresAt: session.expiresAt } });
    cookies.set(id, `sid=${session.token}`);
  }
  base = await app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await app.close();
  await db.world.deleteMany();
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
async function request<T = unknown>(
  path: keyof typeof appRouter._def.procedures,
  data: unknown,
  user: string | null = 'preset-actor',
) {
  const mutation = appRouter._def.procedures[path]._def.type === 'mutation';
  const encoded = JSON.stringify({ 0: data });
  const result = await fetch(`${base}/trpc/${path}?batch=1${mutation ? '' : `&input=${encodeURIComponent(encoded)}`}`, {
    method: mutation ? 'POST' : 'GET',
    headers: {
      origin,
      ...(user ? { cookie: cookies.get(user)! } : {}),
      ...(mutation ? { 'content-type': 'application/json' } : {}),
    },
    ...(mutation ? { body: encoded } : {}),
  });
  const body = (await result.json())[0] as { result?: { data: T }; error?: { data: { code: string } } };
  return { status: result.status, data: body.result?.data, code: body.error?.data.code };
}
async function fixture(preset: WorldPreset, edit: (initial: WorldInit) => void = () => {}) {
  const initial = commandInitial();
  initial.statRules = { min: 15, max: 80, total: 165 };
  initial.generals.forEach((g, i) => {
    g.userId = i === 0 ? users[0]! : i === 3 ? users[1]! : null;
    g.nextTurnTick = i === 0 ? 100 : 9000;
  });
  edit(initial);
  const result = await saveInitialWorld(db, initial, {
    name: '프리셋 시험',
    turnTermMinutes: preset.turnTermMinutes,
    endYear: null,
    preset: { key: 'fixture', value: preset },
  });
  await controlClock(db, result.worldId, 'start');
  return { ...result, initial: { ...initial, presetRules: presetRules(preset) } };
}
async function queue(worldId: string, commandKey: string, args: unknown = {}, user = 'preset-actor') {
  const current = await request<{ revision: number }>('turns.get', { worldId }, user);
  expect(current.status).toBe(200);
  const slots: (QueuedTurn | null)[] = Array.from({ length: 30 }, () => null);
  slots[0] = { commandKey, args };
  const result = await request('turns.set', { worldId, revision: current.data!.revision, slots }, user);
  expect(result.data).toMatchObject({ ok: true });
}
async function advance(worldId: string, tick: number) {
  const lease = await acquireLease(db, worldId);
  if (!lease) throw new Error('시험 월드 실행권이 없습니다.');
  try {
    return await new TurnLoop(db, lease).advanceTo(tick);
  } finally {
    await releaseLease(db, lease);
  }
}
function worker(worldId: string, tick?: number) {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'apps/engine/test/presetWorker.ts', worldId, ...(tick === undefined ? [] : [String(tick)])],
    { cwd: root, env: { ...process.env, TEST_DATABASE_URL: url }, encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(output) as { beforeHash: string; afterHash: string; presetRules: unknown };
}
const createPayload = (worldId: string, name = '신규장수') => ({
  worldId,
  name,
  leadership: 55,
  strength: 55,
  intel: 55,
  portraitId: null,
});

describe('T2-02 실제 DB 생성·고정', () => {
  it.each(['speed', 'beginner'])('%s CLI 생성값과 초기 DB·origin·엔진 해시가 같다', async (key) => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/engine/src/cli/createWorld.ts',
        '--preset',
        key,
        '--rule-features',
        'policy',
        '--seed',
        'preset-cli',
        '--end-year',
        '300',
        '--name',
        '프리셋 CLI',
      ],
      { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 30_000 },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { worldId: string; stateHash: string };
    const preset = await loadPreset(key);
    const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
    expect(world).toMatchObject({
      presetKey: key,
      preset,
      turnTermMinutes: preset.turnTermMinutes,
      scenarioKey: preset.scenario,
      mapKey: preset.map,
      unitSetKey: preset.unitSet,
    });
    const initial = await readWorldState(db, result.worldId);
    expect(hashState(initial)).toBe(result.stateHash);
    const replay = await db.$transaction((tx) => loadReplayState(tx, result.worldId));
    expect(hashState(replay)).toBe(
      hashState(
        enableReplayPolicy(
          initialReplayState(initial, { policy: { version: 1, turnTermMinutes: preset.turnTermMinutes } }),
          preset.turnTermMinutes,
          0,
        ),
      ),
    );
    expect((world.replayOrigin as unknown as { initial: WorldInit }).initial).toEqual(initial);
  });
  it('속성 월드의 실제 엔진이 다음 턴을 10분 뒤로 잡는다', async () => {
    const { worldId } = await fixture(await loadPreset('speed'), (initial) => {
      initial.generals = [initial.generals[0]!];
    });
    await advance(worldId, 100);
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(((general.nextTurnTick - 100) * world.turnTermMinutes * 60000) / 10000).toBe(600000);
  });
  it('CLI 덮어쓰기는 실제 칸에만 남고 원본 스냅샷은 보존한다', async () => {
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/engine/src/cli/createWorld.ts',
        '--preset',
        'speed',
        '--scenario',
        '1030',
        '--map',
        'che',
        '--turn-term',
        '7',
        '--seed',
        'overrides',
        '--end-year',
        '300',
        '--name',
        '프리셋 덮어쓰기',
      ],
      { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 30_000 },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { worldId: string };
    const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
    expect(world.turnTermMinutes).toBe(7);
    expect(world.preset).toEqual(await loadPreset('speed'));
  });
  it('없는 프리셋·경로 이탈·없는 시나리오·필수 인자가 빠진 CLI는 행을 만들지 않는다', async () => {
    const before = await db.world.count();
    for (const args of [
      ['--preset', 'missing'],
      ['--preset', '../beginner'],
      ['--preset', 'speed', '--scenario', 'missing'],
      ['--preset', 'speed', '--turn-term', '0'],
      ['--preset', 'speed', '--end-year', ''],
    ]) {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            '--import',
            'tsx',
            'apps/engine/src/cli/createWorld.ts',
            '--seed',
            'invalid',
            '--end-year',
            '300',
            '--name',
            '실패',
            ...args,
          ],
          { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 30_000 },
        ),
      ).toThrow();
      expect(await db.world.count()).toBe(before);
    }
  }, 120_000);
  it('맞춤 파일의 정규화·실패 원자성과 생성 뒤 파일 변경을 검증한다', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'opensamguk-preset-'));
    try {
      await cp(resourceRoot, temp, { recursive: true });
      const rootUrl = pathToFileURL(`${temp}/`);
      const raw = { ...(await loadPreset('beginner')), commands: { general: [], nation: [] } };
      await writeFile(join(temp, 'preset/custom.json'), JSON.stringify(raw));
      const preset = await loadPreset('custom', rootUrl);
      expect(preset.commands).toBeNull();
      const { worldId } = await saveInitialWorld(db, commandInitial(), {
        name: '맞춤 프리셋',
        turnTermMinutes: 30,
        endYear: null,
        preset: { key: 'custom', value: preset },
      });
      const before = await db.world.count();
      for (const patch of [
        { npc: { fillRatio: 0.5, aggression: 1 } },
        { commands: { general: ['farm'], nation: [] } },
        { protection: { ...preset.protection, maxGeneralsPerNation: 1 } },
      ]) {
        await writeFile(join(temp, 'preset/custom.json'), JSON.stringify({ ...raw, ...patch }));
        await expect(loadPreset('custom', rootUrl)).rejects.toThrow();
        expect(await db.world.count()).toBe(before);
      }
      await writeFile(
        join(temp, 'preset/custom.json'),
        JSON.stringify({
          ...raw,
          protection: { ...raw.protection, peaceMonths: 0 },
          boost: { smallWorld: null, lateJoin: null },
        }),
      );
      const restart = worker(worldId);
      expect(restart.presetRules).toEqual(presetRules(preset));
      expect((await db.world.findUniqueOrThrow({ where: { id: worldId } })).preset).toEqual(preset);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('T2-02 HTTP·엔진·재시작', () => {
  it.each(['attack', 'found'])(
    '%s 보호 기간 안 HTTP 사전 검사와 실제 실행이 같은 코드로 막힌다',
    async (commandKey) => {
      const preset = await loadPreset('beginner');
      const found = commandKey === 'found';
      const { worldId } = await fixture(preset, (initial) => {
        if (found) {
          initial.generals[0]!.nationId = null;
          initial.generals[0]!.officerLevel = 0;
          initial.generals[0]!.cityKey = 3;
        }
      });
      const args = found ? { name: '시험나라', color: '#123456' } : { cityKey: 2 };
      const before = await request('turns.precheck', { worldId, commandKey, args });
      expect(before.data).toMatchObject({ ok: false, code: 'PROTECTED' });
      await queue(worldId, commandKey, args);
      await advance(worldId, 100);
      expect(
        await db.generalLog.findFirstOrThrow({ where: { worldId, generalId: 1 }, orderBy: { id: 'desc' } }),
      ).toMatchObject({ kind: 'failure', text: expect.stringContaining('PROTECTED') });
      const snapshot = hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)));
      expect(worker(worldId)).toMatchObject({
        beforeHash: snapshot,
        afterHash: snapshot,
        presetRules: presetRules(preset),
      });
      expect((await request('turns.precheck', { worldId, commandKey, args })).data).toMatchObject({
        code: 'PROTECTED',
      });
    },
  );
  it.each(['attack', 'found'])('%s 보호 경계 뒤 HTTP와 엔진 실행이 통과한다', async (commandKey) => {
    const preset = await loadPreset('beginner');
    const found = commandKey === 'found';
    const tick = (found ? 12 : 24) * 10000;
    const { worldId } = await fixture(preset, (initial) => {
      initial.generals = [initial.generals[0]!];
      initial.generals[0]!.nextTurnTick = tick;
      if (found) {
        initial.generals[0]!.nationId = null;
        initial.generals[0]!.officerLevel = 0;
        initial.generals[0]!.cityKey = 3;
      }
    });
    const args = found ? { name: '새나라', color: '#123456' } : { cityKey: 2 };
    // 보호 경계의 사전 검사와 실행을 직접 대조한다. 이 월드는 재생 증거에 쓰지 않는다.
    await db.world.update({ where: { id: worldId }, data: { monthlyTick: tick, clockTick: tick } });
    expect((await request('turns.precheck', { worldId, commandKey, args })).data).toEqual({ ok: true });
    await queue(worldId, commandKey, args);
    await advance(worldId, tick);
    expect(await db.generalLog.findFirstOrThrow({ where: { worldId, generalId: 1 } })).toMatchObject({
      kind: 'success',
      commandKey,
    });
  });
  it('국가 선포는 엔진에서 보호되며 현재 일반 명령 전용 HTTP 입력은 거부한다', async () => {
    const { worldId } = await fixture(await loadPreset('beginner'), (initial) => {
      initial.generals[0]!.userId = null;
      initial.diplomacies = [];
      initial.nationTurns = { 1: [{ commandKey: 'nation_declare', args: { nationId: 2 } }] };
    });
    // HTTP는 국가 명령을 받는 경로가 아직 없다(T4-03). BAD_REQUEST를 보호 성공으로 세지 않는다.
    expect(
      (
        await request(
          'turns.precheck',
          { worldId, commandKey: 'nation_declare', args: { nationId: 2 } },
          'preset-other',
        )
      ).code,
    ).toBe('BAD_REQUEST');
    await advance(worldId, 100);
    const history = await db.nationHistory.findFirstOrThrow({ where: { worldId, nationId: 1 } });
    expect(JSON.stringify(history.data)).toContain('PROTECTED');
    expect(await db.diplomacy.count({ where: { worldId } })).toBe(0);
  });
  it('국가 선포 보호 경계 뒤에는 실제 엔진이 외교 상태를 만든다', async () => {
    const tick = 24 * 10000;
    const { worldId } = await fixture(await loadPreset('beginner'), (initial) => {
      initial.generals = [initial.generals[0]!];
      initial.generals[0]!.userId = null;
      initial.generals[0]!.nextTurnTick = tick;
      initial.diplomacies = [];
      initial.nationTurns = { 1: [{ commandKey: 'nation_declare', args: { nationId: 2 } }] };
    });
    await db.world.update({ where: { id: worldId }, data: { monthlyTick: tick, clockTick: tick } });
    await advance(worldId, tick);
    expect(await db.diplomacy.findFirstOrThrow({ where: { worldId } })).toMatchObject({
      nationA: 1,
      nationB: 2,
      state: 'DECLARED',
      untilTick: tick + 10000,
    });
  });
  it('프리셋 출병 가중치가 실제 엔진의 NPC 선택을 바꾼다', async () => {
    for (const [key, commandKey] of [
      ['regular', 'train'],
      ['hardcore', 'attack'],
    ]) {
      const { worldId } = await fixture(await loadPreset(key!), (initial) => {
        initial.generals = [initial.generals[0]!];
        initial.generals[0]!.userId = null;
        initial.generals[0]!.train = 59;
      });
      await advance(worldId, 100);
      expect(await db.generalLog.findFirstOrThrow({ where: { worldId, generalId: 1 } })).toMatchObject({
        kind: 'success',
        commandKey,
      });
    }
  });
  it('사람 300명 미만 내정 보정은 실제 엔진에서 도시 변화만 늘린다', async () => {
    const preset = await loadPreset('beginner');
    const { worldId } = await fixture(preset);
    const state = (await db.$transaction((tx) => loadReplayState(tx, worldId))).state;
    const before = state.cities[1]!.agriculture;
    const plain = structuredClone(state);
    delete plain.presetRules;
    const actor = { generalId: 1, tick: 100, unitSet: commandInitial().unitSet };
    const baseResult = runCommand(plain, actor, 'farm', {}, rngFor('war-contract', 'turn', 100, 1));
    if ('code' in baseResult) throw new Error(baseResult.code);
    const expected = runCommand(state, actor, 'farm', {}, rngFor('war-contract', 'turn', 100, 1));
    if ('code' in expected) throw new Error(expected.code);
    const baseState = applyEffects(plain, baseResult.effects);
    const boosted = applyEffects(state, expected.effects);
    await queue(worldId, 'farm');
    await advance(worldId, 100);
    const city = await db.city.findUniqueOrThrow({ where: { worldId_cityKey: { worldId, cityKey: 1 } } });
    expect(city.agriculture).toBe(boosted.cities[1]!.agriculture);
    expect(city.agriculture - before).toBeGreaterThan(baseState.cities[1]!.agriculture - before);
    const general = await db.general.findUniqueOrThrow({ where: { worldId_id: { worldId, id: 1 } } });
    expect(general.experience).toBe(baseState.generals[1]!.experience);
    expect(general.dedication).toBe(baseState.generals[1]!.dedication);
  });
});

describe('T2-02 참가·권한·재생', () => {
  it.each([
    [1, 1100, 0],
    [2, 1200, 0],
    [3, 1300, 80],
    [5, 1500, 80],
    [8, 1500, 80],
  ])('%i년 참가 HTTP 기록과 엔진 결과는 금·쌀 %i 경험 %i다', async (year, resources, experience) => {
    const { worldId } = await fixture(await loadPreset('beginner'), (initial) => {
      initial.generals.forEach((g, i) => {
        g.experience = (i + 1) * 100;
        g.nextTurnTick = (year + 1) * 120000;
      });
    });
    await db.world.update({ where: { id: worldId }, data: { monthlyTick: year * 120000, clockTick: year * 120000 } });
    const response = request<{ status: string; general: { gold: number; rice: number; experience: number } }>(
      'general.create',
      createPayload(worldId),
      'preset-new',
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } })) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // 엔진의 실제 processCreation이 HTTP가 남긴 입력을 처리한다.
    await advance(worldId, year * 120000);
    const result = await response;
    expect(result.data).toMatchObject({ status: 'created', general: { gold: resources, rice: resources, experience } });
    const event = await db.inputEvent.findFirstOrThrow({ where: { worldId, kind: 'general.create' } });
    expect(event.status).toBe('APPLIED');
    expect(event.result).toMatchObject({ general: { gold: resources, rice: resources, experience } });
  });
  it('보호 월드 HTTP는 무인증·제재·다른 사용자·잘못된 행위자 입력을 거부한다', async () => {
    const { worldId } = await fixture(await loadPreset('beginner'));
    const input = { worldId, commandKey: 'attack', args: { cityKey: 2 } };
    expect((await request('turns.precheck', input, null)).status).toBe(401);
    expect((await request('turns.precheck', input, 'preset-sanctioned')).status).toBe(401);
    expect((await request('turns.precheck', input, 'preset-new')).status).toBe(404);
    expect((await request('turns.precheck', { ...input, generalId: 1 }, 'preset-other')).status).toBe(400);
    expect((await request('general.create', createPayload(worldId), null)).status).toBe(401);
    expect((await request('general.create', createPayload(worldId), 'preset-sanctioned')).status).toBe(401);
    expect(
      (await request('general.create', { ...createPayload(worldId), userId: 'preset-new' }, 'preset-other')).status,
    ).toBe(400);
    expect((await request('general.create', { ...createPayload(worldId), intel: 9999 }, 'preset-new')).status).toBe(
      400,
    );
    expect(await db.inputEvent.count({ where: { worldId, kind: 'general.create' } })).toBe(0);
  });
  it('맞춤 프리셋으로 실제 엔진 12개월·프로세스 재시작·종료 재생 해시가 같다', async () => {
    const preset = await loadPreset('beginner');
    preset.protection.peaceMonths = 3;
    preset.protection.foundUntilMonths = 2;
    preset.boost.lateJoin!.fromYear = 0;
    const { worldId, initial } = await fixture(preset, (initial) => {
      initial.generals = [initial.generals[0]!];
      initial.generals[0]!.crew = 0;
      initial.generals[0]!.experience = 100;
    });
    await queue(worldId, 'farm');
    const creation = request<{ status: string; general: { experience: number } }>(
      'general.create',
      createPayload(worldId),
      'preset-new',
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } })) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await db.inputEvent.count({ where: { worldId, kind: 'general.create', status: 'PENDING' } })).toBe(1);
    await advance(worldId, 100);
    expect((await creation).data).toMatchObject({ status: 'created', general: { experience: 80 } });
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('리스가 없습니다.');
    try {
      const loop = new TurnLoop(db, lease);
      for (let month = 1; month <= 6; month++) {
        await renewLease(db, lease);
        await loop.advanceTo(month * 10000);
      }
    } finally {
      await releaseLease(db, lease);
    }
    const beforeRestart = hashState(await db.$transaction((tx) => loadReplayState(tx, worldId)));
    expect(worker(worldId, 70000).beforeHash).toBe(beforeRestart);
    const afterRestart = await db.$transaction((tx) => loadReplayState(tx, worldId));
    expect(afterRestart.state.presetRules).toEqual(presetRules(preset));
    expect(worker(worldId).afterHash).toBe(hashState(afterRestart));
    const nextLease = await acquireLease(db, worldId);
    if (!nextLease) throw new Error('재시작 리스가 없습니다.');
    try {
      const loop = new TurnLoop(db, nextLease);
      for (let month = 8; month <= 12; month++) {
        await renewLease(db, nextLease);
        await loop.advanceTo(month * 10000);
      }
    } finally {
      await releaseLease(db, nextLease);
    }
    const archive = await exportReplay(db, worldId);
    expect(archive.origin.initial.presetRules).toEqual(initial.presetRules);
    expect(replayArchive(archive, 12)).toHaveLength(12);
    // 종료 조건만 바꾸고 다음 연도 정산까지 실행한다. 설정 변경을 재생 config에도 같은 값으로 반영한다.
    await db.world.update({ where: { id: worldId }, data: { endYear: initial.startYear + 1 } });
    const finalLease = await acquireLease(db, worldId);
    if (!finalLease) throw new Error('종료 리스가 없습니다.');
    try {
      const loop = new TurnLoop(db, finalLease);
      for (let month = 13; month <= 24; month++) {
        await renewLease(db, finalLease);
        await loop.advanceTo(month * 10000);
      }
    } finally {
      await releaseLease(db, finalLease);
    }
    const ended = await exportReplay(db, worldId);
    expect(replayToEnd(ended)).toEqual(ended.end);
  }, 120_000);
  it('기존 v1 origin·초기 해시·12개월 해시는 변경 전 골든 그대로다', async () => {
    const archive = JSON.parse(
      await readFile(new URL('../apps/engine/test/fixtures/replay-v1-b8f5074.json', import.meta.url), 'utf8'),
    ) as ReplayArchive;
    const { worldId } = await saveInitialWorld(db, archive.origin.initial, {
      name: '레거시 골든',
      replayFormat: 'legacy',
      turnTermMinutes: 60,
      endYear: null,
    });
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    expect(world.presetKey).toBeNull();
    expect(world.preset).toBeNull();
    expect(world.initialStateHash).toBe(archive.origin.initialStateHash);
    expect(world.replayOrigin).toEqual(archive.origin);
    expect(Object.hasOwn((await db.$transaction((tx) => loadReplayState(tx, worldId))).state, 'presetRules')).toBe(
      false,
    );
    await controlClock(db, worldId, 'start');
    const lease = await acquireLease(db, worldId);
    if (!lease) throw new Error('레거시 리스가 없습니다.');
    try {
      const loop = new TurnLoop(db, lease);
      for (let month = 1; month <= 12; month++) {
        await renewLease(db, lease);
        await loop.advanceTo(month * 10000);
      }
    } finally {
      await releaseLease(db, lease);
    }
    const result = await exportReplay(db, worldId);
    expect(result.months.map((m) => m.stateHash)).toEqual(archive.months.map((m) => m.stateHash));
    expect(replayArchive(result, 12)).toEqual(replayArchive(archive, 12));
  }, 120_000);
});
