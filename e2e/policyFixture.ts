import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test as base } from '@playwright/test';
import type { monthlyFixture } from '../apps/engine/test/monthlyFixture';
import type { TurnLoop } from '../apps/engine/src/turnLoop';
import { e2eDatabaseUrl, TEST_PASSWORD, withE2eDb } from './account';
import { holdLease, releaseHold, type LeaseHold } from './game';

// T2-14 기본 방침 E2E만 쓰는 실제 DB·API·웹 묶음. 공개 지도 fixture(publicMapFixture.ts)의 방식을 읽어 따랐고 그 파일은 쓰지 않는다.
// 이 worker가 새 _test DB를 만들고 migration을 적용한 뒤 그 DB를 쓰는 자기 API 서버와 Vite 웹 서버를 띄운다.
// 이미 떠 있는 3001·5173 서버와 공유 DB의 행은 건드리지 않는다. 끝나면 자기 서버를 닫고 자기 DB 연결이 0인지 확인한 뒤
// 자기 DB만 지운다. 준비와 정리 결과는 worker마다 test-results/t2-14-fixture-{setup,cleanup}-<DB 이름>.json에 남기고
// 고정 이름 t2-14-fixture-{setup,cleanup}.json에는 마지막 worker 것을 한 벌 더 쓴다.
//
// 시험마다 새 계정과 새 월드를 만든다. 월드는 엔진 월간 fixture를 복사하고 그 계정이 주인인 사람 장수 하나를 초기 상태에 더한다.
// saveInitialWorld의 형식 3에 policy 기능을 지정해 저장하고 실행권을 잡은 뒤 엔진 controlClock으로 연다. 엔진은 시험이 쥔 실행권으로
// 실제 TurnLoop.advanceTo만 돈다(manual). 활동 시각·explicit·전환 표지·InputEvent 결과·시계·tick은 쓰지 않는다.
// 월드 행 직접 쓰기는 거절 조건 fixture(closeWorldForRejection) 한 곳뿐이다.

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const vitePrefix = 't2-14-vite-';

// 초기 상태에 더하는 사람 장수. NPC 장수 1(턴 100)과 2(턴 10,000) 사이에 턴이 온다.
export const HUMAN_ID = 4;
export const HUMAN_TURN = 300;
// 월간 fixture의 국가 1 도시. 농업 200/1000, 보급됨.
const HUMAN_CITY = 3;

export interface PolicyStack {
  database: string;
  databaseUrl: string;
  apiOrigin: string;
  webOrigin: string;
}

// nation: 국가 1의 일반(관직 1)이라 내정이 된다. ronin: 국가가 없어(관직 0) 내정이 실패한다.
export type WorldKind = 'nation' | 'ronin';

export interface PolicyWorld {
  id: string;
  name: string;
  kind: WorldKind;
  email: string;
  userId: string;
  generalId: number;
  hold: LeaseHold;
  loop: TurnLoop;
}

interface ViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

type WorldInit = Awaited<ReturnType<typeof monthlyFixture>>;

// 빈 포트를 잠깐 열어 번호만 얻는다. Vite는 strictPort라 그 사이 다른 프로세스가 가져가면 다른 포트로 가지 않고 실패한다.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

// packages/db의 prisma CLI를 지금 node로 직접 실행한다. Windows에서 pnpm.cmd를 spawn하지 않는다.
async function migrate(url: string): Promise<string> {
  const prismaDir = dirname(createRequire(join(root, 'packages/db/package.json')).resolve('prisma/package.json'));
  const { stdout } = await run(process.execPath, [join(prismaDir, 'build/index.js'), 'migrate', 'deploy'], {
    cwd: join(root, 'packages/db'),
    env: { ...process.env, DATABASE_URL: url },
  });
  return stdout;
}

// apps/web의 vite와 기존 vite.config.ts로 같은 화면 소스를 띄운다. 포트와 API 주소만 이 묶음 것으로 바꾼다.
// 의존성 캐시는 임시 폴더에 두어 5173 서버의 캐시를 고치지 않는다.
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

export async function record(name: string, data: unknown) {
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results', name), `${JSON.stringify(data, null, 2)}\n`);
}

let template: Promise<WorldInit> | undefined;
let passwordHash: Promise<string> | undefined;

// 월간 fixture(도시 4, 국가 2, NPC 장수 3)를 복사하고 시험 계정의 사람 장수를 더한다. 외교는 비운다.
function worldState(source: WorldInit, kind: WorldKind, userId: string, name: string): WorldInit {
  const state = structuredClone(source);
  const npc = state.generals[0]!;
  state.generals.push({
    ...npc,
    id: HUMAN_ID,
    userId,
    name,
    portraitId: null,
    nationId: kind === 'nation' ? 1 : null,
    officerLevel: kind === 'nation' ? 1 : 0,
    cityKey: HUMAN_CITY,
    activeFromYear: state.startYear,
    nextTurnTick: HUMAN_TURN,
    personality: null,
    special: null,
    gold: 1000,
    rice: 1000,
    injury: 0,
  });
  state.diplomacies = [];
  return state;
}

async function createWorld(kind: WorldKind): Promise<PolicyWorld> {
  const [{ monthlyFixture }, { saveInitialWorld }, { controlClock }, { TurnLoop }, { hashPassword }] =
    await Promise.all([
      import('../apps/engine/test/monthlyFixture'),
      import('../apps/engine/src/world/persistence'),
      import('../apps/engine/src/world/clock'),
      import('../apps/engine/src/turnLoop'),
      import('../apps/server/src/auth/password'),
    ]);
  template ??= monthlyFixture();
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const tag = randomBytes(4).toString('hex');
  const email = `e2e-policy-${tag}@example.test`;
  const name = `E2E 방침 ${kind} ${tag}`;
  const hash = await passwordHash;
  const source = await template;
  const { userId, worldId } = await withE2eDb(async (db) => {
    // 계정 행만 만든다. 세션은 화면 로그인으로 서버가 만든다.
    const user = await db.user.create({ data: { email, passwordHash: hash }, select: { id: true } });
    const saved = await saveInitialWorld(db, worldState(source, kind, user.id, '방침시험'), {
      name,
      turnTermMinutes: 1440,
      endYear: null,
      ruleFeatures: ['policy'],
    });
    return { userId: user.id, worldId: saved.worldId };
  });
  // 감독이 없는 자기 DB지만 TurnLoop가 쓸 실행권을 월드를 열기 전에 잡는다.
  const hold = await holdLease(worldId);
  try {
    await withE2eDb((db) => controlClock(db, worldId, 'start'));
  } catch (error) {
    await releaseHold(hold);
    throw error;
  }
  return {
    id: worldId,
    name,
    kind,
    email,
    userId,
    generalId: HUMAN_ID,
    hold,
    loop: new TurnLoop(hold.db, hold.lease),
  };
}

// 엔진 함수로 tick까지 진행한다. 입력·턴·월간 정산은 엔진이 정상으로 처리한다.
export async function advance(world: PolicyWorld, tick: number) {
  if (world.hold.lost) throw world.hold.lost;
  const executions = await world.loop.advanceTo(tick);
  if (world.hold.lost) throw world.hold.lost;
  return executions;
}

export function readWorld(world: PolicyWorld) {
  return world.hold.db.world.findUniqueOrThrow({
    where: { id: world.id },
    select: { clockTick: true, status: true, policyFromSequence: true },
  });
}

// 시계를 움직이지 않고 쌓인 입력만 처리한다. 저장된 clockTick까지만 진행하므로 턴이 끼지 않는다.
export async function processInputs(world: PolicyWorld) {
  const { clockTick } = await readWorld(world);
  return advance(world, clockTick);
}

const policyInputSelect = {
  kind: true,
  status: true,
  payload: true,
  result: true,
  userId: true,
  generalId: true,
} as const;

// 내 장수의 방침 입력. 읽기만 한다.
export function policyInputs(world: PolicyWorld) {
  return world.hold.db.inputEvent.findMany({
    where: { worldId: world.id, generalId: world.generalId, kind: 'general.setPolicy' },
    orderBy: { id: 'asc' },
    select: policyInputSelect,
  });
}

export function allInputs(world: PolicyWorld) {
  return world.hold.db.inputEvent.findMany({
    where: { worldId: world.id },
    orderBy: { id: 'asc' },
    select: policyInputSelect,
  });
}

// API가 방침 입력을 PENDING으로 접수할 때까지 기다린다. 화면의 setPolicy는 5초까지 결과를 기다리므로 그 안에 본다.
export async function waitPendingPolicy(world: PolicyWorld) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const row = await world.hold.db.inputEvent.findFirst({
      where: { worldId: world.id, generalId: world.generalId, kind: 'general.setPolicy', status: 'PENDING' },
      orderBy: { id: 'asc' },
      select: policyInputSelect,
    });
    if (row) return row;
    await delay(50);
  }
  throw new Error('방침 입력이 PENDING으로 접수되지 않았습니다.');
}

export function myGeneral(world: PolicyWorld) {
  return world.hold.db.general.findUniqueOrThrow({
    where: { worldId_id: { worldId: world.id, id: world.generalId } },
    select: {
      userId: true,
      nationId: true,
      officerLevel: true,
      cityKey: true,
      nextTurnTick: true,
      defaultPolicy: true,
      lastActiveTick: true,
      gold: true,
    },
  });
}

export function myLogs(world: PolicyWorld) {
  return world.hold.db.generalLog.findMany({
    where: { worldId: world.id, generalId: world.generalId },
    orderBy: { tick: 'asc' },
    select: { tick: true, commandKey: true, kind: true, text: true },
  });
}

export function myCity(world: PolicyWorld) {
  return world.hold.db.city.findUniqueOrThrow({
    where: { worldId_cityKey: { worldId: world.id, cityKey: HUMAN_CITY } },
    select: { nationId: true, agriculture: true, agricultureMax: true, supplied: true },
  });
}

// UI 거절 조건 fixture. 월드 상태 전환의 제품 증거가 아니다.
// 공개 API가 방침 입력을 PENDING으로 접수해 pending을 준 뒤에만 부른다. 이 fixture가 만든 이 월드 행 하나의 status만 ENDED로 쓴다.
// 거절은 그 뒤 진짜 TurnLoop의 processPendingInput이 WORLD_CLOSED로 만든다. InputEvent의 상태·결과는 쓰지 않는다.
export async function closeWorldForRejection(world: PolicyWorld) {
  const pending = await world.hold.db.inputEvent.count({
    where: { worldId: world.id, generalId: world.generalId, kind: 'general.setPolicy', status: 'PENDING' },
  });
  if (pending !== 1) throw new Error('거절 조건은 방침 입력 하나가 PENDING일 때만 만듭니다.');
  const updated = await world.hold.db.world.updateMany({
    where: { id: world.id, status: 'RUNNING' },
    data: { status: 'ENDED' },
  });
  if (updated.count !== 1) throw new Error('거절 조건 월드를 찾지 못했습니다.');
  return { worldId: world.id, field: 'status', from: 'RUNNING', to: 'ENDED', pendingPolicyInputs: pending };
}

export const test = base.extend<
  { policyWorld: (kind: WorldKind) => Promise<PolicyWorld>; evidence: Record<string, unknown> },
  { policyStack: PolicyStack }
>({
  policyStack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // 원래 주소가 _test 전용 DB인지 먼저 확인하고 같은 서버·계정에 새 이름의 _test DB를 만든다. 있는 DB는 지우거나 비우지 않는다.
      const original = e2eDatabaseUrl();
      const database = `e2e_policy_${randomBytes(6).toString('hex')}_test`;
      if (!/^e2e_policy_[a-f0-9]{12}_test$/.test(database)) throw new Error('방침 E2E DB 이름이 잘못되었습니다.');
      // 시험이 실패하면 Playwright가 새 worker로 다음 시험을 돌리므로 고정 이름 파일은 다음 worker 기록으로 덮인다.
      // 확인한 자기 DB 이름을 붙인 파일에 worker마다 따로 남기고 고정 이름 파일은 마지막 worker의 편의본으로 둔다.
      const setupFile = `t2-14-fixture-setup-${database}.json`;
      const cleanupFile = `t2-14-fixture-cleanup-${database}.json`;
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
        const migrated = await migrate(databaseUrl);

        // withE2eDb·holdLease는 DATABASE_URL을 읽는다. 이 worker 안에서만 자기 DB로 바꾸고 끝나면 되돌린다.
        // 이 worker fixture를 쓰는 파일은 다른 파일과 worker를 나눠 쓰지 않는다.
        process.env.DATABASE_URL = databaseUrl;
        process.env.TEST_DATABASE_URL = databaseUrl;

        // 서버는 평소처럼 Date.now로 세션과 시각을 판정한다. 브라우저 POST의 Origin은 자기 웹 출처와 같아야 받는다.
        const webPort = await freePort();
        const webOrigin = `http://127.0.0.1:${webPort}`;
        db = createDb(databaseUrl);
        api = await buildServer({
          db,
          logging: false,
          publicOrigin: webOrigin,
          realtime: { connectionString: databaseUrl },
        });
        await api.listen({ host: '127.0.0.1', port: 0 });
        const apiOrigin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        cacheDir = await mkdtemp(join(tmpdir(), vitePrefix));
        vite = await startWeb(webPort, apiOrigin, cacheDir);

        const setup = {
          database,
          apiOrigin,
          webOrigin,
          exists: await exists(),
          migrate: migrated.trim().split('\n').slice(-3),
        };
        await record(setupFile, setup);
        await record('t2-14-fixture-setup.json', setup);
        await use({ database, databaseUrl, apiOrigin, webOrigin });
      } catch (error) {
        failure = error;
      } finally {
        const step = async (name: string, work: () => Promise<unknown>) => {
          try {
            await work();
            cleanup[name] = true;
          } catch (error) {
            cleanup[name] = String(error);
            errors.push(error);
          }
        };
        await step('webClosed', async () => vite?.close());
        await step('apiClosed', async () => api?.close());
        await step('apiDbDisconnected', async () => db?.$disconnect());
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        // 값은 남기지 않고 두 변수가 원래 값으로 돌아왔는지만 남긴다.
        cleanup.envRestored =
          process.env.DATABASE_URL === saved.DATABASE_URL && process.env.TEST_DATABASE_URL === saved.TEST_DATABASE_URL;
        await step('viteCacheRemoved', async () => {
          if (cacheDir === undefined) return;
          // mkdtemp가 만든 tmpdir 바로 아래 t2-14-vite- 폴더일 때만 지운다. 아니면 지우지 않고 실패한다.
          const target = resolve(cacheDir);
          const name = basename(target);
          if (dirname(target) !== resolve(tmpdir()) || !name.startsWith(vitePrefix) || name.length <= vitePrefix.length)
            throw new Error('방침 E2E Vite 캐시 경로가 임시 폴더 아래 자기 폴더가 아니라 지우지 않았습니다.');
          await rm(target, { recursive: true, force: true });
        });
        if (created)
          await step('dropped', async () => {
            // 풀이 끊긴 연결을 서버가 거두는 짧은 시간만 기다린다. 남아 있으면 지우지 않고 실패한다.
            let left = await connections();
            for (let tries = 0; left > 0 && tries < 50; tries++) {
              await delay(100);
              left = await connections();
            }
            cleanup.connectionsBeforeDrop = left;
            if (left !== 0) throw new Error(`방침 E2E DB에 연결 ${left}개가 남아 지우지 않았습니다.`);
            await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
            cleanup.existsAfterDrop = await exists();
          });
        await step('adminDisconnected', () => admin.$disconnect());
        // 두 기록은 서버·DB 정리를 모두 마친 뒤 따로 쓴다. 하나가 실패해도 다른 하나는 쓰고 실패는 정리 실패로 남는다.
        await step('recorded', () => record(cleanupFile, cleanup));
        await step('latestRecorded', () => record('t2-14-fixture-cleanup.json', cleanup));
      }
      // 정리를 모두 마친 뒤 본 실패를 먼저, 없으면 정리 실패를 던진다.
      if (failure !== undefined) throw failure;
      if (errors.length > 0) throw new AggregateError(errors, '방침 E2E 묶음을 정리하지 못했습니다.');
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ policyStack }, use) => use(policyStack.webOrigin),
  // 시험마다 새 계정과 새 월드. 끝나면 그 월드의 실행권과 DB 연결을 놓는다.
  policyWorld: async ({ policyStack }, use) => {
    // 아래에서 DB를 쓰는 도우미가 모두 이 묶음의 DB를 가리키는지 먼저 확인한다.
    if (e2eDatabaseUrl() !== policyStack.databaseUrl) throw new Error('방침 E2E가 자기 DB를 쓰지 않습니다.');
    const made: PolicyWorld[] = [];
    let failure: unknown;
    try {
      await use(async (kind) => {
        const world = await createWorld(kind);
        made.push(world);
        return world;
      });
    } catch (error) {
      failure = error;
    }
    const errors: unknown[] = [];
    for (const world of made) {
      try {
        await releaseHold(world.hold);
      } catch (error) {
        errors.push(error);
      }
    }
    if (failure !== undefined) throw failure;
    if (errors.length > 0) throw new AggregateError(errors, '방침 E2E 월드의 실행권을 놓지 못했습니다.');
  },
  // 시험이 모은 응답 원문·DB 행·기대값. 시험 제목 앞 번호로 test-results/t2-14-e2e-<번호>.json에 남긴다.
  // eslint-disable-next-line no-empty-pattern
  evidence: async ({}, use, testInfo) => {
    const data: Record<string, unknown> = {};
    await use(data);
    const number = /^(\d+) /.exec(testInfo.title)?.[1];
    if (!number) throw new Error('방침 E2E 시험 제목이 번호로 시작하지 않습니다.');
    await record(`t2-14-e2e-${number}.json`, {
      title: testInfo.title,
      status: testInfo.status,
      expectedStatus: testInfo.expectedStatus,
      ...data,
    });
  },
});

export { expect } from '@playwright/test';
