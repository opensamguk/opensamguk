import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  test as base,
  type APIResponse,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import { e2eDatabaseUrl, TEST_PASSWORD, withE2eDb } from './account';
import { holdLease, releaseHold, type LeaseHold } from './game';

// T2-10 메시지·실시간 E2E만 쓰는 실제 DB·API·웹 묶음. policyFixture.ts(T2-14)의 worker 묶음 방식을 읽어 이 파일 안에 따로 썼고
// 그 파일과 공통 E2E 도우미는 고치지 않는다 (계획 T2-10 "실제 API 연결 보완").
// 이 worker가 새 _test DB를 만들고 migration을 적용한 뒤 그 DB를 쓰는 자기 API 서버와 Vite 웹 서버를 띄운다.
// 이미 떠 있는 3001·5173 서버, 공유 DB의 행, 다른 프로세스의 LISTEN 연결은 건드리지 않는다. 끝나면 자기 서버를 닫고
// 자기 DB 연결이 0인지 확인한 뒤 자기 DB만 지운다. 준비와 정리 결과는 test-results/t2-10-fixture-{setup,cleanup}-<DB 이름>.json에 남긴다.
// 세션 토큰·쿠키·비밀번호·DB 주소는 기록과 로그에 남기지 않는다.
//
// 시험마다 새 월드를 만든다. 공개 시험 상태(readFixture)를 T2-09 통합 시험처럼 장수 6명으로 늘려 역할을 고정하고
// 장수마다 새 계정을 붙인다. 실행권을 먼저 잡은 뒤 엔진 controlClock으로 열고, 턴은 시험이 실제 TurnLoop.advanceTo로만 돌린다.

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const vitePrefix = 't210-vite-';

// 측정할 장수의 턴 tick. 다른 장수는 이보다 한참 뒤라 advanceTo가 이 장수의 턴만 실행한다.
export const TURN_TICK = 500;
const LATER_TICK = 1_000_000;

// 장수 번호는 순서대로 1~6이다. 소속·직책은 T2-09 통합 시험(tools/t2-09.integration.test.ts)과 같다.
export const ROLES = {
  ruler: { generalId: 1, nationId: 1, officerLevel: 12 },
  adviser: { generalId: 2, nationId: 1, officerLevel: 11 },
  rival: { generalId: 3, nationId: 2, officerLevel: 12 },
  ronin: { generalId: 4, nationId: null, officerLevel: 0 },
  rivalMember: { generalId: 5, nationId: 2, officerLevel: 1 },
  member: { generalId: 6, nationId: 1, officerLevel: 1 },
} as const;
export type Role = keyof typeof ROLES;

export interface T210Stack {
  database: string;
  databaseUrl: string;
  apiOrigin: string;
  webOrigin: string;
  applicationName: string;
}

export interface T210User {
  role: Role;
  generalId: number;
  userId: string;
  context: BrowserContext;
  page: Page;
}

export interface T210World {
  id: string;
  stack: T210Stack;
  hold: LeaseHold;
  // 역할의 브라우저 문맥을 처음 부를 때 연다. 문맥마다 그 계정의 세션 쿠키만 든다.
  user(role: Role): Promise<T210User>;
}

interface ViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

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

async function record(name: string, data: unknown) {
  await mkdir(join(root, 'test-results'), { recursive: true });
  await writeFile(join(root, 'test-results', name), `${JSON.stringify(data, null, 2)}\n`);
}

// DB를 쓰는 도우미가 모두 이 묶음의 DB를 가리키는지 확인한다.
function assertOwnDb(stack: T210Stack) {
  if (e2eDatabaseUrl() !== stack.databaseUrl) throw new Error('T2-10 E2E가 자기 DB를 쓰지 않습니다.');
}

let passwordHash: Promise<string> | undefined;

// 계정·세션 행을 자기 DB에 바로 만든다. 비밀번호 해시와 세션 토큰은 서버의 auth 모듈로 만들고 값은 어디에도 남기지 않는다.
async function createSessionAccount(stack: T210Stack, tag: string, index: number) {
  const [{ hashPassword }, { newSession }] = await Promise.all([
    import('../apps/server/src/auth/password'),
    import('../apps/server/src/auth/session'),
  ]);
  passwordHash ??= hashPassword(TEST_PASSWORD);
  const hash = await passwordHash;
  const session = newSession(Date.now());
  assertOwnDb(stack);
  const user = await withE2eDb((db) =>
    db.user.create({
      data: {
        email: `e2e-t210-${tag}-${index}@example.test`,
        passwordHash: hash,
        sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
      },
      select: { id: true },
    }),
  );
  return { userId: user.id, token: session.token };
}

async function createWorld(stack: T210Stack, tag: string) {
  const [{ readFixture }, { saveInitialWorld }, { controlClock }] = await Promise.all([
    import('../apps/server/test/readFixture'),
    import('../apps/engine/src/world/persistence'),
    import('../apps/engine/src/world/clock'),
  ]);
  const accounts: Array<Awaited<ReturnType<typeof createSessionAccount>>> = [];
  for (let i = 0; i < 6; i++) accounts.push(await createSessionAccount(stack, tag, i + 1));
  const initial = await readFixture();
  initial.generals.push({ ...initial.generals[2]!, id: 5 }, { ...initial.generals[0]!, id: 6 });
  const roles = Object.values(ROLES);
  initial.generals = initial.generals.map((general, i) => ({
    ...general,
    name: `시험장수${i + 1}`,
    userId: accounts[i]!.userId,
    nationId: roles[i]!.nationId,
    officerLevel: roles[i]!.officerLevel,
    nextTurnTick: roles[i]!.generalId === ROLES.member.generalId ? TURN_TICK : LATER_TICK,
  }));
  assertOwnDb(stack);
  const { worldId } = await withE2eDb((db) =>
    saveInitialWorld(db, initial, { name: `T2-10 메시지 ${tag}`, turnTermMinutes: 60, endYear: null }),
  );
  // 감독이 없는 자기 DB지만 TurnLoop가 쓸 실행권을 월드를 열기 전에 잡는다.
  const hold = await holdLease(worldId);
  try {
    await withE2eDb((db) => controlClock(db, worldId, 'start'));
  } catch (error) {
    await releaseHold(hold);
    throw error;
  }
  return { worldId, hold, accounts };
}

// 화면과 같은 /trpc 경로로 조회한다. 문맥의 baseURL과 쿠키를 쓴다.
async function unwrap(response: APIResponse, path: string) {
  const body = (await response.json()) as { result?: { data?: unknown }; error?: { data?: { code?: string } } };
  if (!response.ok()) throw new Error(`${path}: HTTP ${response.status()} ${body.error?.data?.code ?? ''}`);
  return body.result?.data;
}

export async function apiQuery<T>(user: T210User, path: string, input?: unknown): Promise<T> {
  const search = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  return (await unwrap(await user.context.request.get(`/trpc/${path}${search}`), path)) as T;
}

// 서버는 /trpc POST에 같은 출처의 Origin을 요구한다. 공통 appOrigin()은 config의 baseURL을 읽어 이 묶음과 어긋나므로
// 이 묶음의 웹 출처를 직접 적는다.
export async function apiMutate<T>(world: T210World, user: T210User, path: string, input: unknown): Promise<T> {
  const response = await user.context.request.post(`/trpc/${path}`, {
    data: input,
    headers: { Origin: world.stack.webOrigin },
  });
  return (await unwrap(response, path)) as T;
}

// httpBatchLink 요청에서 path별 입력을 꺼낸다. 주소는 /trpc/a,b?batch=1이고 입력은 GET의 input이나 POST 본문의
// {"0": …, "1": …}에서 path 순번으로 찾는다. batch가 아니면 입력 그대로다.
export function trpcCalls(request: Request): Array<{ path: string; input: unknown }> {
  const url = new URL(request.url());
  const prefix = '/trpc/';
  if (!url.pathname.startsWith(prefix)) return [];
  const paths = url.pathname.slice(prefix.length).split(',').map(decodeURIComponent);
  let raw: unknown = null;
  try {
    raw =
      request.method() === 'GET'
        ? JSON.parse(url.searchParams.get('input') ?? 'null')
        : (request.postDataJSON() as unknown);
  } catch {
    raw = null;
  }
  const batch = url.searchParams.get('batch') === '1';
  return paths.map((path, index) => ({
    path,
    input: batch ? (raw as Record<string, unknown> | null)?.[String(index)] : raw,
  }));
}

export function trpcInputs(request: Request, path: string): unknown[] {
  return trpcCalls(request)
    .filter((call) => call.path === path)
    .map((call) => call.input);
}

// 응답 묶음에서 path의 결과 data를 꺼낸다.
export async function trpcResult(response: Response, path: string): Promise<unknown> {
  const calls = trpcCalls(response.request());
  const index = calls.findIndex((call) => call.path === path);
  if (index < 0) throw new Error(`${path} 응답이 아닙니다.`);
  const body = (await response.json()) as unknown;
  const entry = (Array.isArray(body) ? body[index] : body) as { result?: { data?: unknown } } | undefined;
  return entry?.result?.data;
}

// 페이지가 보낸 tRPC 호출을 시각과 함께 모은다.
export function recordTrpc(page: Page): Array<{ path: string; input: unknown; at: number }> {
  const seen: Array<{ path: string; input: unknown; at: number }> = [];
  page.on('request', (request) => {
    const at = Date.now();
    for (const call of trpcCalls(request)) seen.push({ ...call, at });
  });
  return seen;
}

// 측정할 장수의 턴을 실제 TurnLoop로 실행한다. 반환값은 그 장수의 기록을 쓴 트랜잭션이 commit하기 직전(beforeCommit)의 시각이다.
// 실제 commit보다 이르므로 이 시각부터 잰 시간은 commit부터 화면 표시까지의 상한이다.
export async function advanceTurn(world: T210World, generalId: number): Promise<number> {
  const { TurnLoop } = await import('../apps/engine/src/turnLoop');
  const before = await world.hold.db.generalLog.count({ where: { worldId: world.id, generalId } });
  let committedAt: number | undefined;
  const loop = new TurnLoop(world.hold.db, world.hold.lease, {
    beforeCommit: async (tx) => {
      if (committedAt !== undefined) return;
      const logs = await tx.generalLog.count({ where: { worldId: world.id, generalId } });
      if (logs > before) committedAt = Date.now();
    },
  });
  if (world.hold.lost) throw world.hold.lost;
  await loop.advanceTo(TURN_TICK);
  if (world.hold.lost) throw world.hold.lost;
  if (committedAt === undefined) throw new Error('측정할 장수의 턴이 실행되지 않았습니다.');
  return committedAt;
}

// 소속·직책을 바꾼다. 엔진 TurnLoop와 같은 월드 행 잠금(FOR UPDATE)을 잡은 트랜잭션에서 이 월드의 장수 한 행만 쓴다.
export async function setGeneral(
  world: T210World,
  generalId: number,
  data: { nationId: number | null; officerLevel: number },
) {
  const count = await world.hold.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${world.id} FOR UPDATE`;
    return (await tx.general.updateMany({ where: { worldId: world.id, id: generalId }, data })).count;
  });
  if (count !== 1) throw new Error('바꿀 장수를 찾지 못했습니다.');
}

// 국가 공지 행을 정한 판 번호로 쓴다. 같은 revision의 두 국가 시험용이며 notice.nation.set의 제품 증거가 아니다.
export async function setNationNotice(world: T210World, nationId: number, body: string, revision: number) {
  const count = await world.hold.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${world.id} FOR UPDATE`;
    return (
      await tx.nation.updateMany({
        where: { worldId: world.id, id: nationId },
        data: { notice: body, noticeRevision: revision, noticeUpdatedAt: new Date(), noticeUpdatedBy: '시험' },
      })
    ).count;
  });
  if (count !== 1) throw new Error('공지를 쓸 국가를 찾지 못했습니다.');
}

// 다음 쪽 병합 시험용 개인 메시지. 모두 지금보다 이른 서로 다른 시각이다.
export async function seedPrivateMessages(world: T210World, from: Role, to: Role, count: number) {
  const sender = ROLES[from];
  const recipient = ROLES[to];
  const start = Date.now() - 3_600_000;
  await world.hold.db.message.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      worldId: world.id,
      scope: 'PRIVATE' as const,
      senderId: sender.generalId,
      senderNationId: sender.nationId,
      recipientId: recipient.generalId,
      fromParty: { generalId: sender.generalId, name: `시험장수${sender.generalId}`, nation: null },
      toParty: { generalId: recipient.generalId, name: `시험장수${recipient.generalId}`, nation: null },
      body: `쌓인 메시지 ${String(i + 1).padStart(2, '0')}`,
      sentAt: new Date(start + i * 1_000),
      year: 191,
      month: 1,
    })),
  });
}

// 화면이 home.get을 다시 받게 하는 실시간 신호. 실제 PostgreSQL NOTIFY와 SSE 경로를 타지만 월간 정산의 증거가 아니다.
export async function refreshSignal(world: T210World) {
  const { notifyWorld } = await import('../packages/db/src/index');
  if (!(await notifyWorld(world.hold.db, world.id, { kind: 'monthly.done', target: 'world' })))
    throw new Error('실시간 신호를 보내지 못했습니다.');
}

export const test = base.extend<{ world: T210World }, { t210Stack: T210Stack }>({
  t210Stack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // 원래 주소가 _test 전용 DB인지 먼저 확인하고 같은 서버·계정에 새 이름의 _test DB를 만든다. 있는 DB는 지우거나 비우지 않는다.
      const original = e2eDatabaseUrl();
      const hex = randomBytes(6).toString('hex');
      const database = `e2e_t210_${hex}_test`;
      if (!/^e2e_t210_[a-f0-9]{12}_test$/.test(database)) throw new Error('T2-10 E2E DB 이름이 잘못되었습니다.');
      const applicationName = `t210-${hex}`;
      const setupFile = `t2-10-fixture-setup-${database}.json`;
      const cleanupFile = `t2-10-fixture-cleanup-${database}.json`;
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
        // 실시간 LISTEN 연결에는 이 묶음만의 applicationName을 붙인다.
        const webPort = await freePort();
        const webOrigin = `http://127.0.0.1:${webPort}`;
        db = createDb(databaseUrl);
        const { initializeResources } = await import('../tools/init-resources');
        await initializeResources(
          db,
          await readFile(new URL('../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
        );
        api = await buildServer({
          db,
          logging: false,
          publicOrigin: webOrigin,
          realtime: { connectionString: databaseUrl, applicationName },
        });
        await api.listen({ host: '127.0.0.1', port: 0 });
        const apiOrigin = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
        cacheDir = await mkdtemp(join(tmpdir(), vitePrefix));
        vite = await startWeb(webPort, apiOrigin, cacheDir);

        await record(setupFile, {
          database,
          apiOrigin,
          webOrigin,
          applicationName,
          exists: await exists(),
          migrate: migrated.trim().split('\n').slice(-3),
        });
        await use({ database, databaseUrl, apiOrigin, webOrigin, applicationName });
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
          // mkdtemp가 만든 tmpdir 바로 아래 t210-vite- 폴더일 때만 지운다. 아니면 지우지 않고 실패한다.
          const target = resolve(cacheDir);
          const name = basename(target);
          if (dirname(target) !== resolve(tmpdir()) || !name.startsWith(vitePrefix) || name.length <= vitePrefix.length)
            throw new Error('T2-10 E2E Vite 캐시 경로가 임시 폴더 아래 자기 폴더가 아니라 지우지 않았습니다.');
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
            if (left !== 0) throw new Error(`T2-10 E2E DB에 연결 ${left}개가 남아 지우지 않았습니다.`);
            await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
            cleanup.existsAfterDrop = await exists();
          });
        await step('adminDisconnected', () => admin.$disconnect());
        await step('recorded', () => record(cleanupFile, cleanup));
      }
      // 정리를 모두 마친 뒤 본 실패를 먼저, 없으면 정리 실패를 던진다.
      if (failure !== undefined) throw failure;
      if (errors.length > 0) throw new AggregateError(errors, 'T2-10 E2E 묶음을 정리하지 못했습니다.');
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ t210Stack }, use) => use(t210Stack.webOrigin),
  // 시험마다 새 월드와 역할 6개. 끝나면 연 브라우저 문맥을 닫고 실행권과 그 DB 연결을 놓는다. 실패는 숨기지 않고 던진다.
  world: async ({ t210Stack, browser }, use) => {
    assertOwnDb(t210Stack);
    const tag = randomBytes(4).toString('hex');
    const { worldId, hold, accounts } = await createWorld(t210Stack, tag);
    const opened = new Map<Role, T210User>();
    const world: T210World = {
      id: worldId,
      stack: t210Stack,
      hold,
      async user(role) {
        const existing = opened.get(role);
        if (existing) return existing;
        const { generalId } = ROLES[role];
        const account = accounts[generalId - 1]!;
        const context = await browser.newContext({
          baseURL: t210Stack.webOrigin,
          storageState: { cookies: [], origins: [] },
        });
        await context.addCookies([
          { name: 'sid', value: account.token, url: t210Stack.webOrigin, httpOnly: true, sameSite: 'Lax' },
        ]);
        const page = await context.newPage();
        const user: T210User = { role, generalId, userId: account.userId, context, page };
        opened.set(role, user);
        return user;
      },
    };
    let failure: unknown;
    try {
      await use(world);
    } catch (error) {
      failure = error;
    }
    const errors: unknown[] = [];
    for (const user of opened.values()) {
      try {
        await user.context.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await releaseHold(hold);
    } catch (error) {
      errors.push(error);
    }
    if (failure !== undefined) throw failure;
    if (errors.length > 0) throw new AggregateError(errors, 'T2-10 E2E 월드를 정리하지 못했습니다.');
  },
});

export { expect } from '@playwright/test';
