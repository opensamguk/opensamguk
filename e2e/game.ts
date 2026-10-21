import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

// 실제 서버·DB·엔진으로 게임 화면을 시험하는 도우미 (T1-15).
// pnpm dev의 엔진은 RUNNING 월드 중 가장 먼저 만든 것 하나만 돌린다. world.list도 같은 순서라 그 첫 월드를 쓴다.
// 없으면 1분 턴 월드를 만들고 시작한다. 1분 턴이라 시험 중에도 장수 턴이 실행된다 (waitTurnWindow 참고).

if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');

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

export async function mutate<T = Json>(page: Page, path: string, input: unknown): Promise<T> {
  return (await unwrap(await page.request.post(`/trpc/${path}`, { data: input }), path)) as T;
}

let worldId: string | undefined;

export async function e2eWorld(page: Page): Promise<string> {
  if (worldId) return worldId;
  const { worlds } = await query<{ worlds: Array<{ id: string }> }>(page, 'world.list');
  if (worlds[0]) return (worldId = worlds[0].id);
  const created = run([
    'world:create',
    '--scenario',
    '1030',
    '--map',
    'che',
    '--seed',
    `e2e-${Date.now()}`,
    '--turn-term',
    '1',
    '--name',
    'E2E 월드',
  ]);
  const id = (JSON.parse(created.trim().split('\n').at(-1)!) as { worldId: string }).worldId;
  run(['world:start', '--world', id]);
  return (worldId = id);
}

function run(args: string[]): string {
  const result = spawnSync('pnpm', ['-s', ...args], { encoding: 'utf8', env: process.env });
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
  const { createDb } = await import('../packages/db/src/index');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL이 필요합니다.');
  const db = createDb(url);
  try {
    const updated = await db.user.updateMany({ where: { email }, data: { status } });
    if (updated.count !== 1) throw new Error('계정을 찾지 못했습니다.');
  } finally {
    await db.$disconnect();
  }
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
