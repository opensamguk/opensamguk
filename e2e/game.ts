import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Lease } from '../apps/engine/src/lease';
import type { PrismaClient } from '../packages/db/src/index';
import { pnpmCli } from '../tools/node-cli';
import { appOrigin, e2eDatabaseUrl, withE2eDb } from './account';

// 실제 서버·DB·엔진으로 게임 화면을 시험하는 도우미 (T1-15).
// pnpm dev의 엔진 감독은 10초마다 RUNNING·PAUSED 월드를 모두 찾아 월드마다 엔진을 하나씩 띄운다 (T2-01).
// world.list는 RUNNING 월드를 만든 순서로 주므로 그 첫 월드를 쓴다. 없으면 1분 턴 월드를 만들고 시작한다.
// 1분 턴이라 시험 중에도 장수 턴이 실행된다 (waitTurnWindow 참고).
// DB를 직접 쓰는 도우미는 account.ts의 e2eDatabaseUrl로 E2E 전용 DB(_test)만 쓴다.

type Json = Record<string, unknown>;

async function unwrap(response: Awaited<ReturnType<APIRequestContext['get']>>, path: string) {
  const body = (await response.json()) as { result?: { data?: unknown }; error?: { data?: { code?: string } } };
  if (!response.ok()) throw new ApiError(path, response.status(), body.error?.data?.code);
  return body.result?.data;
}

export class ApiError extends Error {
  constructor(
    path: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`${path}: HTTP ${status} ${code ?? ''}`);
  }
}

// 브라우저와 쿠키를 같이 쓰는 요청. 화면과 같은 세션으로 API를 부른다.
export async function query<T = Json>(page: Page, path: string, input?: unknown): Promise<T> {
  const search = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  return (await unwrap(await page.request.get(`/trpc/${path}${search}`), path)) as T;
}

// 서버는 /trpc POST에 같은 출처의 Origin을 요구한다 (T3-04). 브라우저와 달리 page.request는 Origin을 붙이지 않으므로
// 화면과 같은 출처를 직접 적는다. 본문은 data로 보내 Content-Type이 application/json이 된다.
export async function mutate<T = Json>(page: Page, path: string, input: unknown): Promise<T> {
  return (await unwrap(
    await page.request.post(`/trpc/${path}`, { data: input, headers: { Origin: appOrigin() } }),
    path,
  )) as T;
}

function databaseUrl(): string {
  return e2eDatabaseUrl();
}

// PREOPEN 월드를 만든다. 감독은 world:start로 RUNNING이 된 뒤에야 이 월드를 찾는다.
function createWorld(seed: string, name: string, ruleFeatures: string[] = []): string {
  const created = run([
    'world:create',
    '--scenario',
    '1030',
    '--map',
    'che',
    '--seed',
    seed,
    '--turn-term',
    '1',
    '--end-year',
    '300',
    '--name',
    name,
    ...(ruleFeatures.length ? ['--rule-features', ruleFeatures.join(',')] : []),
  ]);
  return (JSON.parse(created.trim().split('\n').at(-1)!) as { worldId: string }).worldId;
}

let worldId: string | undefined;
// 기능 검사는 기존 월드의 설정을 바꾸지 않고 필요한 기능을 켠 전용 월드를 만든다.
export async function e2eFeatureWorld(ruleFeatures: string[], options: { npcNations?: boolean } = {}): Promise<string> {
  const id = createWorld(`e2e-features-${Date.now()}`, 'E2E 기능 월드', ruleFeatures);
  if (options.npcNations !== undefined)
    await withE2eDb((db) => db.nation.updateMany({ where: { worldId: id }, data: { isNpc: options.npcNations } }));
  run(['world:start', '--world', id]);
  await waitEngineReady(id);
  return id;
}

export async function e2eWorld(page: Page): Promise<string> {
  if (worldId) return worldId;
  const { worlds } = await query<{ worlds: Array<{ id: string }> }>(page, 'world.list');
  let id = worlds[0]?.id;
  if (!id) {
    id = createWorld(`e2e-${Date.now()}`, 'E2E 월드');
    run(['world:start', '--world', id]);
  }
  await waitEngineReady(id);
  return (worldId = id);
}

// 감독이 이 월드의 엔진을 띄워 실행권을 잡으면 엔진이 곧바로 heartbeat를 쓰고 30초마다 고친다.
// 시간을 정해 두고 기다리지 않고, 이 월드의 heartbeat가 최근 것이고 오류가 없을 때 시험을 시작한다.
async function waitEngineReady(world: string) {
  const { createDb } = await import('../packages/db/src/index');
  const { HEARTBEAT_MS } = await import('../apps/engine/src/main');
  const db = createDb(databaseUrl());
  try {
    await expect
      .poll(
        async () => {
          const rows = await db.$queryRaw<Array<{ ready: boolean }>>`
            SELECT "lastError" IS NULL AND "at" > clock_timestamp() - ${HEARTBEAT_MS * 2} * interval '1 millisecond' AS ready
            FROM "EngineHeartbeat" WHERE "worldId" = ${world}`;
          return rows[0]?.ready ?? false;
        },
        {
          message: '엔진 감독이 시험 월드의 엔진을 띄우지 않았습니다. pnpm dev의 엔진 로그를 확인하세요.',
          timeout: 90_000,
          intervals: [500, 1_000],
        },
      )
      .toBe(true);
  } finally {
    await db.$disconnect();
  }
}

export interface LeaseHold {
  db: PrismaClient;
  lease: Lease;
  done: AbortController;
  renewal: Promise<void>;
  lost?: unknown;
}

let idle: { id: string; hold: LeaseHold } | undefined;

// 감독이 띄운 엔진이 처리하지 못하는 RUNNING 월드. 생성 요청이 엔진 처리 전까지 pending으로 남는 경우를 만든다.
// 서버와 엔진은 RUNNING 월드에서만 장수를 만들어 PREOPEN 월드로는 이 경우를 만들 수 없다.
// 그래서 시험이 이 월드의 실제 실행권(EngineLease)을 시작 전에 잡고 계속 갱신한다. 감독이 띄운 엔진은
// 실행권을 얻지 못해 기다리고, 입력은 시험이 startEngine으로 같은 실행권을 써서 턴 루프를 돌릴 때만 처리된다.
export async function idleWorld(page: Page): Promise<string> {
  await e2eWorld(page);
  if (idle) return idle.id;
  const id = createWorld(`e2e-idle-${Date.now()}`, 'E2E 대기 월드');
  const hold = await holdLease(id);
  try {
    run(['world:start', '--world', id]);
  } catch (error) {
    await releaseHold(hold);
    throw error;
  }
  idle = { id, hold };
  return id;
}

export async function holdLease(world: string): Promise<LeaseHold> {
  const { createDb } = await import('../packages/db/src/index');
  const { acquireLease, renewLease, LEASE_TTL_MS } = await import('../apps/engine/src/lease');
  const db = createDb(databaseUrl());
  const lease = await acquireLease(db, world).catch(async (error: unknown) => {
    await db.$disconnect();
    throw error;
  });
  if (!lease) {
    await db.$disconnect();
    throw new Error('대기 월드의 엔진 실행권을 잡지 못했습니다.');
  }
  const done = new AbortController();
  const hold: LeaseHold = { db, lease, done, renewal: Promise.resolve() };
  hold.renewal = (async () => {
    while (!done.signal.aborted) {
      try {
        await delay(LEASE_TTL_MS / 3, undefined, { signal: done.signal });
        await renewLease(db, lease);
      } catch (error) {
        if (!done.signal.aborted) hold.lost = error;
        return;
      }
    }
  })();
  return hold;
}

export async function releaseHold(hold: LeaseHold) {
  const { releaseLease } = await import('../apps/engine/src/lease');
  hold.done.abort();
  await hold.renewal;
  try {
    await releaseLease(hold.db, hold.lease);
  } finally {
    await hold.db.$disconnect();
  }
}

// 대기 월드의 실행권을 놓는다. 그 뒤로는 감독이 띄운 엔진이 이 월드를 돌린다.
export async function releaseIdleWorld() {
  if (!idle) return;
  const { hold } = idle;
  idle = undefined;
  await releaseHold(hold);
}

// 시험이 쥔 대기 월드의 실행권으로 기존 엔진의 턴 루프(runEngine이 돌리는 TurnLoop)를 돌린다.
// 돌려받은 함수를 부르면 루프만 멈추고 실행권은 계속 쥔다. 그래서 다시 보낸 생성 요청도 pending으로 남는다.
export async function startEngine(world: string): Promise<() => Promise<void>> {
  if (idle?.id !== world) throw new Error('startEngine은 idleWorld로 만든 월드에만 씁니다.');
  const { hold } = idle;
  const { TurnLoop } = await import('../apps/engine/src/turnLoop');
  const loop = new TurnLoop(hold.db, hold.lease);
  const controller = new AbortController();
  const running = (async () => {
    try {
      while (!controller.signal.aborted) {
        if (hold.lost) throw hold.lost;
        await loop.poll(controller.signal);
        await delay(100, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  // 실패는 멈출 때 다시 던진다.
  running.catch(() => undefined);
  return async () => {
    controller.abort();
    await running;
  };
}

// 월드에 이미 있는 NPC 장수 이름. 같은 이름으로 만들면 엔진이 NAME_TAKEN으로 거절한다.
export async function takenGeneralName(world: string): Promise<string> {
  return withE2eDb(
    async (db) => (await db.general.findFirstOrThrow({ where: { worldId: world }, select: { name: true } })).name,
  );
}

function run(args: string[]): string {
  e2eDatabaseUrl();
  const result = spawnSync(...pnpmCli(['-s', ...args]), { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} 실패: ${result.stderr}`);
  return result.stdout;
}

// 장수 이름은 1~6글자, 월드 안에서 겹치지 않아야 한다.
export function newGeneralName(): string {
  return `E${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
}

export interface OwnGeneral {
  id: number;
  name: string;
  portraitId: number | null;
  leadership: number;
  strength: number;
  intel: number;
}

export async function mine(page: Page, world: string) {
  return query<{ general: OwnGeneral | null; creation: { status: string } | null }>(page, 'general.mine', {
    worldId: world,
  });
}

export async function createGeneralByApi(page: Page, world: string, name = newGeneralName()): Promise<OwnGeneral> {
  const result = await mutate<{ status: string; general?: OwnGeneral }>(page, 'general.create', {
    worldId: world,
    name,
    leadership: 55,
    strength: 55,
    intel: 55,
    portraitId: null,
  });
  if (result.status === 'created' && result.general) return result.general;
  let general: OwnGeneral | null = null;
  await expect.poll(async () => (general = (await mine(page, world)).general), { timeout: 30_000 }).not.toBeNull();
  return general!;
}

export interface Slot {
  commandKey: string;
  args: Record<string, unknown>;
  name: string;
}

export async function turns(page: Page, world: string) {
  return query<{ revision: number; slots: Slot[] }>(page, 'turns.get', { worldId: world });
}

export async function setTurns(page: Page, world: string, slots: Array<{ commandKey: string } | null>) {
  const { revision } = await turns(page, world);
  const all = Array.from({ length: 30 }, (_, i) => slots[i] ?? null);
  return mutate<{ ok: boolean }>(page, 'turns.set', { worldId: world, revision, slots: all });
}

async function nextTurnAt(page: Page, world: string): Promise<number | null> {
  const home = await query<{ nextTurnAt: string | null }>(page, 'home.get', { worldId: world });
  return home.nextTurnAt === null ? null : Date.parse(home.nextTurnAt);
}

// 다음 턴까지 needMs 이상 남을 때까지 기다린다. 턴이 실행되면 예턴이 한 칸 당겨지므로,
// 칸 위치를 확인하는 시험은 이 창 안에서 끝낸다. 엔진이 밀린 턴을 따라잡는 중이면 따라잡을 때까지 기다린다.
export async function waitTurnWindow(page: Page, world: string, needMs = 30_000, limitMs = 100_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const at = await nextTurnAt(page, world);
    if (at === null) return;
    const left = at - Date.now();
    if (left >= needMs) return;
    await page.waitForTimeout(Math.min(Math.max(0, left) + 3_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    '다음 턴까지 시험할 여유가 생기지 않았습니다. 엔진이 돌고 있는지, 턴 간격이 1분 이상인지 확인하세요.',
  );
}

// 다음 턴이 실행될 때까지 기다린다. 반환값은 실행 예정 시각(ms)이다.
export async function waitNextTurn(page: Page, world: string, timeoutMs = 150_000) {
  const at = await nextTurnAt(page, world);
  if (at === null) throw new Error('월드가 멈춰 있어 턴이 실행되지 않습니다.');
  if (at - Date.now() > timeoutMs)
    throw new Error('다음 턴이 시험 제한 시간보다 늦습니다. 1분 턴 월드에서 실행하세요.');
  return at;
}

// 제재(SANCTIONED)는 관리자 화면이 아직 없어(M3) DB로 바꾼다.
export async function setUserStatus(email: string, status: 'ACTIVE' | 'SANCTIONED') {
  const updated = await withE2eDb((db) => db.user.updateMany({ where: { email }, data: { status } }));
  if (updated.count !== 1) throw new Error('계정을 찾지 못했습니다.');
}

// 초상 이미지는 외부 저장소 주소다. 네트워크에 기대지 않도록 시험용 그림으로 바꾼다.
export async function stubPortraits(page: Page) {
  await page.route('**/portraits/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="68"><rect width="48" height="68" fill="#8a5a2b"/></svg>',
    }),
  );
}
