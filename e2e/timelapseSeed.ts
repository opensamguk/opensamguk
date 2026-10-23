import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test as base } from '@playwright/test';
import type { Prisma, PrismaClient } from '../packages/db/src/index';
import { nodeCli } from '../tools/node-cli';
import { e2eDatabaseUrl } from './account';

// T4-36 · AC-P2-17 (나) 영토 재생 E2E만 쓰는 실제 DB·API·웹 묶음과 월드 준비 (docs/plans/T4-36.md 4.2).
// worker마다 새 _test DB를 만들고 migration을 적용한 뒤 그 DB를 쓰는 자기 API 서버(포트 0)와 Vite 웹 서버(빈 포트)를 띄운다.
// 이미 떠 있는 3001·5173 서버와 공유 DB의 행은 건드리지 않는다. 감독 엔진은 띄우지 않고 준비 단계의 TurnLoop만 월드를 움직인다.
// 끝나면 자기 서버를 닫고 자기 DB 연결이 0인지 확인한 뒤 자기 DB만 지운다. 준비·정리 결과는 test-results/t4-36-fixture-*.json에
// 남기고 연결 문자열·세션 토큰·비밀번호는 남기지 않는다.
// 임시 폴더는 실행기가 T4_36_E2E_TMPDIR로 넘긴다. Windows에서는 시스템 드라이브 밖이어야 하며 넘기지 않으면 시작하지 않는다.

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const vitePrefix = 't4-36-vite-';
const TEMP_ENV = 'T4_36_E2E_TMPDIR';
const DATABASE_NAME = /^e2e_timelapse_[0-9a-f]{32}_test$/;
const TICKS_PER_MONTH = 10_000;
const PREP_HASH = 't4-36-e2e-prep';

export interface StoredNation {
  id: number;
  name: string;
  color: string;
}

// DB 준비 월드의 도시 키. warFixture의 네 도시와 nationArchive.integration.test.ts와 같은 경계 도시 999다.
export const CITY_KEYS = [1, 2, 3, 4, 999] as const;

// DB 준비 월드의 저장 국가 표시값. 그 월드의 지금 Nation 행(시나리오 값)과 일부러 다르게 둔다.
export const SAVED = {
  wei: { id: 1, name: '위', color: '#000080' },
  wu: { id: 2, name: '오', color: '#ff0000' },
  shu: { id: 1, name: '촉', color: '#008000' },
  han: { id: 2, name: '한', color: '#ffd700' },
} as const satisfies Record<string, StoredNation>;

// 프레임 하나. month는 시작부터 센 달(tick = month × 10000), owners는 CITY_KEYS 순서의 소유 국가다.
export interface FrameSpec {
  month: number;
  owners: Array<number | null>;
  nations: StoredNation[];
}

// A: 35개월. 도시 1은 달마다 국가 1과 2를 번갈아 가진다. 30개 페이지 경계를 넘는다.
export const aFrame = (k: number): FrameSpec => ({
  month: k + 1,
  owners: [k % 2 === 0 ? 1 : 2, 2, null, 1, null],
  nations: [SAVED.wei, SAVED.wu],
});
// B: A와 겹치지 않는 40~42번째 달 3개. 소유도 A와 다르다. E10에서 A의 날짜가 섞였는지 가린다.
const bFrame = (k: number): FrameSpec => ({
  month: 40 + k,
  owners: [2, 2, 1, 1, null],
  nations: [SAVED.shu, SAVED.han],
});
// M: 3개월. 둘째 달만 국가 2의 YearbookNation 행을 넣지 않는다.
const mFrame = (k: number): FrameSpec => ({
  month: k + 1,
  owners: [1, 2, null, 1, null],
  nations: k === 1 ? [SAVED.wei] : [SAVED.wei, SAVED.wu],
});

export interface PreparedWorld {
  id: string;
  name: string;
  startYear: number;
  ticks: number[];
}
export interface PreparedWorlds {
  a: PreparedWorld;
  b: PreparedWorld;
  c: PreparedWorld;
  m: PreparedWorld;
  p: PreparedWorld;
  // P 첫 정산(tick 10000)에 엔진이 저장한 국가 1·2의 값. E4·E5의 기대값이다.
  pSaved: { first: StoredNation; removed: StoredNation };
}
export interface TimelapseStack {
  database: string;
  databaseUrl: string;
  apiOrigin: string;
  webOrigin: string;
  worlds: PreparedWorlds;
}

interface ViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

// 실행기가 넘긴 임시 폴더를 확인한다. 경로를 지어내지 않고 tmpdir()의 시스템 기본값으로 바꾸지도 않는다(Windows).
async function tempBase(): Promise<string> {
  const supplied = process.env[TEMP_ENV];
  if (supplied === undefined || supplied === '') {
    if (process.platform === 'win32')
      throw new Error(`${TEMP_ENV}에 시스템 드라이브 밖의 임시 폴더를 넘겨야 영토 재생 E2E를 시작합니다.`);
    return resolve(tmpdir());
  }
  if (!isAbsolute(supplied)) throw new Error(`${TEMP_ENV}는 절대 경로여야 합니다.`);
  const dir = resolve(supplied);
  if (process.platform === 'win32') {
    const drive = parse(dir).root.toUpperCase();
    const system = `${(process.env.SystemDrive ?? '').toUpperCase()}\\`;
    if (!/^[A-Z]:\\$/.test(drive) || drive === system)
      throw new Error(`${TEMP_ENV}가 시스템 드라이브나 드라이브 문자가 없는 경로라 쓰지 않습니다.`);
  }
  if (!(await stat(dir)).isDirectory()) throw new Error(`${TEMP_ENV}가 폴더가 아닙니다.`);
  return dir;
}

// 자식 프로세스의 임시 폴더도 같은 곳으로 둔다.
const tempEnv = (dir: string) => ({ TMP: dir, TEMP: dir, TMPDIR: dir });

// 빈 포트를 잠깐 열어 번호만 얻는다. Vite는 strictPort라 그 사이 다른 프로세스가 가져가면 다른 포트로 가지 않고 실패한다.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', done);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done, fail) => probe.close((error) => (error ? fail(error) : done())));
  return port;
}

// packages/db의 prisma CLI를 지금 node로 직접 실행한다. 셸과 pnpm.cmd를 띄우지 않는다.
async function migrate(url: string, temp: string): Promise<string> {
  const prismaDir = dirname(createRequire(join(root, 'packages/db/package.json')).resolve('prisma/package.json'));
  const { stdout } = await run(...nodeCli(join(prismaDir, 'build/index.js'), ['migrate', 'deploy']), {
    cwd: join(root, 'packages/db'),
    env: { ...process.env, ...tempEnv(temp), DATABASE_URL: url },
  });
  return stdout;
}

// apps/web의 vite와 기존 vite.config.ts로 같은 화면 소스를 띄운다. 포트와 API 주소만 이 묶음 것으로 바꾼다.
// 의존성 캐시는 실행기가 넘긴 임시 폴더 아래 자기 폴더에 두어 5173 서버의 캐시를 고치지 않는다.
async function startWeb(port: number, apiOrigin: string, cacheDir: string): Promise<ViteServer> {
  const webRoot = join(root, 'apps/web');
  const vitePath = createRequire(join(webRoot, 'package.json')).resolve('vite');
  const { createServer: createVite } = (await import(pathToFileURL(vitePath).href)) as {
    createServer: (config: Record<string, unknown>) => Promise<ViteServer>;
  };
  const vite = await createVite({
    configFile: join(webRoot, 'vite.config.ts'),
    root: webRoot,
    cacheDir,
    logLevel: 'error',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, proxy: { '/trpc': apiOrigin, '/sse': apiOrigin } },
  });
  try {
    await vite.listen();
  } catch (error) {
    await vite.close();
    throw error;
  }
  return vite;
}

async function record(name: string, data: unknown) {
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results', name), `${JSON.stringify(data, null, 2)}\n`);
}

function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`영토 재생 E2E 준비 확인 실패: ${message}`);
}

const cityData = (owners: ReadonlyArray<number | null>) => ({
  cities: CITY_KEYS.map((cityKey, i) => ({ cityKey, nationId: owners[i] ?? null })),
});

// DB 준비 프레임. YearbookSnapshot과 그 tick의 YearbookNation 행만 넣는다. 응답을 지어내지 않고 서버가 이 행을 읽는다.
export async function insertFrame(db: PrismaClient, world: PreparedWorld, spec: FrameSpec): Promise<number> {
  const { toGameDate } = await import('../packages/rules/src/index');
  const tick = spec.month * TICKS_PER_MONTH;
  const { year, month } = toGameDate(world.startYear, tick);
  await db.yearbookSnapshot.create({
    data: {
      worldId: world.id,
      tick,
      year,
      month,
      sequence: spec.month,
      data: cityData(spec.owners),
      stateHash: PREP_HASH,
    },
  });
  if (spec.nations.length > 0)
    await db.yearbookNation.createMany({
      data: spec.nations.map(({ id, name, color }) => ({ worldId: world.id, tick, nationId: id, name, color })),
    });
  return tick;
}

// 시험이 넣은 프레임을 지운다. YearbookNation은 외래 키 cascade로 함께 지워진다.
export async function removeFrame(db: PrismaClient, worldId: string, tick: number) {
  await db.yearbookSnapshot.deleteMany({ where: { worldId, tick } });
}

// 프레임 날짜 문구. 화면의 frameDate와 같은 모양을 기대값으로 직접 적는다.
export async function dateOf(world: PreparedWorld, tick: number): Promise<string> {
  const { toGameDate } = await import('../packages/rules/src/index');
  const { year, month } = toGameDate(world.startYear, tick);
  return `${year}년 ${month}월`;
}

async function borderWorld() {
  const { warFixture } = await import('../apps/engine/test/warFixture');
  const initial = await warFixture();
  // 조기 통일을 막는 경계 도시 (nationArchive.integration.test.ts:33-40과 같음).
  initial.cities.push({
    ...initial.cities[0]!,
    cityKey: 999,
    name: '보존 검증 경계 도시',
    nationId: null,
    connections: [],
    supplied: false,
  });
  return initial;
}

async function prepareWorlds(db: PrismaClient): Promise<PreparedWorlds> {
  const [{ saveInitialWorld }, { controlClock }, lease, { TurnLoop }, rules, dbModule] = await Promise.all([
    import('../apps/engine/src/world/persistence'),
    import('../apps/engine/src/world/clock'),
    import('../apps/engine/src/lease'),
    import('../apps/engine/src/turnLoop'),
    import('../packages/rules/src/index'),
    import('../packages/db/src/index'),
  ]);
  const tag = randomUUID().slice(0, 8);
  const save = async (label: string, initial: Awaited<ReturnType<typeof borderWorld>>) => {
    const name = `E2E 영토 ${tag} ${label}`;
    const { worldId } = await saveInitialWorld(db, initial, {
      replayFormat: 'legacy',
      name,
      turnTermMinutes: 60,
      endYear: null,
    });
    const { startYear } = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { startYear: true } });
    return { id: worldId, name, startYear, ticks: [] as number[] };
  };
  const seeded = async (label: string, specs: FrameSpec[]) => {
    const world = await save(label, await borderWorld());
    for (const spec of specs) world.ticks.push(await insertFrame(db, world, spec));
    return world;
  };

  // A·B·C·M은 PREOPEN 그대로 두고 프레임은 DB 준비로 넣는다.
  const a = await seeded(
    'A',
    Array.from({ length: 35 }, (_, k) => aFrame(k)),
  );
  const b = await seeded('B', [0, 1, 2].map(bFrame));
  const c = await seeded('C', []);
  const m = await seeded('M', [0, 1, 2].map(mFrame));

  // P는 실제 엔진으로 정산 저장과 출병 멸망을 지난다 (nationArchive.integration.test.ts R1/S3와 같은 장면).
  const initial = await borderWorld();
  initial.generals[0]!.nextTurnTick = 10_100;
  const userPrefix = `t4-36-${tag}-g`;
  for (const general of initial.generals) {
    general.userId = `${userPrefix}${general.id}`;
    await db.user.create({
      data: { id: general.userId, email: `${general.userId}@example.test`, passwordHash: 'fixture-only' },
    });
  }
  const p = await save('P', initial);
  await controlClock(db, p.id, 'start');
  const held = await lease.acquireLease(db, p.id, randomUUID(), 120_000);
  check(held !== null, 'P 월드 실행권을 얻지 못했습니다.');
  try {
    const loop = new TurnLoop(db, held);
    await loop.advanceTo(10_000);
    const first = await db.yearbookNation.findMany({
      where: { worldId: p.id, tick: 10_000 },
      orderBy: { nationId: 'asc' },
      select: { nationId: true, name: true, color: true },
    });
    check(first.map(({ nationId }) => nationId).join() === '1,2', '첫 정산 저장 국가가 1·2가 아닙니다.');

    // 장수 1의 출병 예턴을 API가 쓰는 것과 같은 행으로 넣는다 (nationArchive.integration.test.ts:60-96).
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${p.id} FOR UPDATE`;
      const actor = await tx.general.findUniqueOrThrow({ where: { worldId_id: { worldId: p.id, id: 1 } } });
      const turns = rules.emptyTurns();
      turns[0] = { commandKey: 'attack', args: { cityKey: 2 } };
      await tx.generalTurn.deleteMany({ where: { worldId: p.id, generalId: 1 } });
      await tx.generalTurn.createMany({
        data: turns.map((turn, slot) => ({
          ...turn,
          explicit: true,
          worldId: p.id,
          generalId: 1,
          slot,
          args: turn.args as Prisma.InputJsonValue,
        })),
      });
      await tx.general.update({
        where: { worldId_id: { worldId: p.id, id: 1 } },
        data: { turnRevision: { increment: 1 } },
      });
      const sequence = await dbModule.nextActionSequence(tx, p.id);
      await tx.inputEvent.create({
        data: {
          worldId: p.id,
          userId: actor.userId!,
          generalId: 1,
          kind: 'turns.set',
          idempotencyKey: `t4-36-${sequence}`,
          status: 'APPLIED',
          sequence,
          payload: { turns, revision: actor.turnRevision } as unknown as Prisma.InputJsonValue,
          result: { revision: actor.turnRevision + 1 },
        },
      });
    });
    await lease.renewLease(db, held);
    await loop.advanceTo(10_100);
    const alive = await db.nation.findUnique({ where: { worldId_id: { worldId: p.id, id: 2 } } });
    const removed = await db.removedNation.findUnique({
      where: { worldId_nationId: { worldId: p.id, nationId: 2 } },
    });
    check(alive === null, '출병 뒤에도 국가 2의 Nation 행이 남았습니다.');
    check(removed !== null, '국가 2의 RemovedNation 행이 없습니다.');

    await lease.renewLease(db, held);
    await loop.advanceTo(20_000);
    const second = await db.yearbookNation.findMany({
      where: { worldId: p.id, tick: 20_000 },
      select: { nationId: true },
    });
    check(second.map(({ nationId }) => nationId).join() === '1', '둘째 정산 저장 국가가 1뿐이 아닙니다.');
    const frames = await db.yearbookSnapshot.findMany({
      where: { worldId: p.id },
      orderBy: { tick: 'asc' },
      select: { tick: true, data: true },
    });
    check(frames.map(({ tick }) => tick).join() === '10000,20000', 'P 프레임 tick이 다릅니다.');
    const owners = (frames[1]!.data as { cities: Array<{ nationId: number | null }> }).cities.map((c) => c.nationId);
    check(owners.includes(1) && owners.every((id) => id === null || id === 1), '둘째 프레임 소유가 다릅니다.');
    p.ticks.push(...frames.map(({ tick }) => tick));
    await controlClock(db, p.id, 'pause');
    const toStored = ({ nationId, name, color }: (typeof first)[number]) => ({ id: nationId, name, color });
    return { a, b, c, m, p, pSaved: { first: toStored(first[0]!), removed: toStored(first[1]!) } };
  } finally {
    // 준비가 끝나면 실행권을 놓는다. 감독 엔진이 없으므로 그 뒤 월드 상태는 시험이 바꾸는 것뿐이다.
    await lease.releaseLease(db, held);
  }
}

export const test = base.extend<object, { timelapseStack: TimelapseStack }>({
  timelapseStack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // 원래 주소가 _test 전용 DB인지 먼저 확인하고 같은 서버·계정에 새 이름의 _test DB를 만든다. 있는 DB는 지우거나 비우지 않는다.
      const original = e2eDatabaseUrl();
      const database = `e2e_timelapse_${randomUUID().replaceAll('-', '')}_test`;
      if (!DATABASE_NAME.test(database)) throw new Error('영토 재생 E2E DB 이름이 잘못되었습니다.');
      const temp = await tempBase();
      const own = new URL(original);
      own.pathname = `/${database}`;
      const adminUrl = new URL(original);
      adminUrl.pathname = '/postgres';
      const databaseUrl = own.href;

      const { createDb } = await import('../packages/db/src/index');
      const { buildServer } = await import('../apps/server/src/server');
      const admin = createDb(adminUrl.href);
      const saved = { DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
      const connections = async () =>
        (
          await admin.$queryRaw<
            Array<{ n: number }>
          >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${database}`
        )[0]!.n;
      const exists = async () =>
        (
          await admin.$queryRaw<
            Array<{ n: number }>
          >`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${database}`
        )[0]!.n;
      const cleanup: Record<string, unknown> = { database };
      let created = false;
      let db: ReturnType<typeof createDb> | undefined;
      let api: Awaited<ReturnType<typeof buildServer>> | undefined;
      let vite: ViteServer | undefined;
      let cacheDir: string | undefined;
      let failure: unknown;
      const errors: unknown[] = [];
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const migrated = await migrate(databaseUrl, temp);

        // withE2eDb는 DATABASE_URL을 읽는다. 이 worker 안에서만 자기 DB로 바꾸고 끝나면 되돌린다.
        // 이 worker fixture를 쓰는 파일은 serial이고 다른 파일과 worker를 나눠 쓰지 않는다.
        process.env.DATABASE_URL = databaseUrl;
        process.env.TEST_DATABASE_URL = databaseUrl;

        // 브라우저 POST의 Origin은 자기 웹 출처와 같아야 서버가 받는다.
        const webPort = await freePort();
        const webOrigin = `http://127.0.0.1:${webPort}`;
        db = createDb(databaseUrl);
        const worlds = await prepareWorlds(db);
        api = await buildServer({
          db,
          logging: false,
          publicOrigin: webOrigin,
          realtime: { connectionString: databaseUrl },
        });
        await api.listen({ host: '127.0.0.1', port: 0 });
        const apiOrigin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        cacheDir = await mkdtemp(join(temp, vitePrefix));
        vite = await startWeb(webPort, apiOrigin, cacheDir);

        const { a, b, c, m, p } = worlds;
        await record('t4-36-fixture-setup.json', {
          database,
          apiOrigin,
          webOrigin,
          tempDrive: parse(temp).root,
          exists: await exists(),
          migrate: migrated.trim().split('\n').slice(-3),
          frames: { a: a.ticks.length, b: b.ticks.length, c: c.ticks.length, m: m.ticks.length, p: p.ticks.length },
        });
        await use({ database, databaseUrl, apiOrigin, webOrigin, worlds });
      } catch (error) {
        failure = error;
      } finally {
        const step = async (name: string, work: () => Promise<unknown>) => {
          try {
            await work();
            cleanup[name] = true;
          } catch (error) {
            // 오류 문구에 연결 정보가 섞일 수 있어 기록에는 이름만 남긴다.
            cleanup[name] = error instanceof Error ? error.name : 'error';
            errors.push(error);
          }
        };
        await step('webClosed', async () => vite?.close());
        await step('apiClosed', async () => api?.close());
        await step('dbDisconnected', async () => db?.$disconnect());
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        // 값은 남기지 않고 두 변수가 원래 값으로 돌아왔는지만 남긴다.
        cleanup.envRestored =
          process.env.DATABASE_URL === saved.DATABASE_URL && process.env.TEST_DATABASE_URL === saved.TEST_DATABASE_URL;
        await step('viteCacheRemoved', async () => {
          if (cacheDir === undefined) return;
          // mkdtemp가 만든 실행기 임시 폴더 바로 아래 t4-36-vite- 폴더일 때만 지운다. 아니면 지우지 않고 실패한다.
          const target = resolve(cacheDir);
          const name = basename(target);
          if (dirname(target) !== resolve(temp) || !name.startsWith(vitePrefix) || name.length <= vitePrefix.length)
            throw new Error('영토 재생 E2E Vite 캐시 경로가 임시 폴더 아래 자기 폴더가 아니라 지우지 않았습니다.');
          await rm(target, { recursive: true, force: true });
        });
        if (created)
          await step('dropped', async () => {
            if (!DATABASE_NAME.test(database)) throw new Error('자기 DB 이름이 아니라 지우지 않았습니다.');
            // 풀이 끊긴 연결을 서버가 거두는 짧은 시간만 기다린다. 남아 있으면 지우지 않고 실패한다.
            let left = await connections();
            for (let tries = 0; left > 0 && tries < 50; tries++) {
              await new Promise((done) => setTimeout(done, 100));
              left = await connections();
            }
            cleanup.connectionsBeforeDrop = left;
            if (left !== 0) throw new Error(`영토 재생 E2E DB에 연결 ${left}개가 남아 지우지 않았습니다.`);
            await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
            cleanup.existsAfterDrop = await exists();
          });
        await step('adminDisconnected', () => admin.$disconnect());
        await step('recorded', () => record('t4-36-fixture-cleanup.json', cleanup));
      }
      // 정리를 모두 마친 뒤 본 실패를 먼저, 없으면 정리 실패를 던진다.
      if (failure !== undefined) throw failure;
      if (errors.length > 0) throw new AggregateError(errors, '영토 재생 E2E 묶음을 정리하지 못했습니다.');
    },
    { scope: 'worker', timeout: 300_000 },
  ],
  baseURL: async ({ timelapseStack }, use) => use(timelapseStack.webOrigin),
});

export { expect } from '@playwright/test';
