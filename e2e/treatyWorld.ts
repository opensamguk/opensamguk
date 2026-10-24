import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Browser, type BrowserContext, type Page, type Request, type Route } from '@playwright/test';
import type { PrismaClient } from '../packages/db/src/index';
import type { WorldInit } from '../packages/rules/src/index';
import { appOrigin, e2eDatabaseUrl } from './account';
import { createGeneralByApi, mutate, query } from './game';

// T2-07 첫 세 조항 브라우저 시험의 월드 fixture (AC-M2-06).
// 실제 1030·che 초기 상태에서 국가 20개의 국고·NPC 여부·관계만 정한 뒤 실제 saveInitialWorld로 조약 월드 T(treatyFormat 1)와
// 같은 입력의 대조 월드 L(형식 플래그 없음)을 만든다. 시작은 실제 controlClock이고 엔진은 실행 중인 감독이 띄운다.
// 이 파일이 DB에 직접 쓰는 것은 계정·세션, 장수의 소속·직위·첫 턴, B5의 국고 비우기뿐이다. 모두 시험 준비이며 게임 증거가 아니다.
// 조약·입력·외교 행은 읽기만 한다. 실행권을 잡거나 TurnLoop을 직접 돌리거나 heartbeat를 쓰지 않는다.

export const TURN_TERM_MINUTES = 120;
// 120분 턴의 첫 월 경계. 시험 동안 정기 실행과 월 정산(국고 수입, 불가침 만료)이 끼지 않게 모든 장수의 첫 턴을 여기로 미룬다.
export const FIRST_DUE_TICK = 10_000;
// 선포 관계의 기한. 시험 시간보다 충분히 뒤다.
const DECLARED_UNTIL_TICK = 120_000;
const RICH = 100_000;
const WEB_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:'];
const EVENT_FIELDS = {
  id: true,
  kind: true,
  idempotencyKey: true,
  status: true,
  generalId: true,
  userId: true,
  result: true,
} as const;

type Relation = { state: 'WAR' | 'DECLARED'; untilTick: number };

// 국가 쌍. 쌍끼리 겹치지 않아 한 쌍의 조약이 다른 쌍의 관계·비용·안내를 바꾸지 않는다.
export const PAIRS = {
  P1: { a: 1, b: 2, goldB: RICH, relation: null, npcB: false },
  P2: { a: 3, b: 4, goldB: RICH, relation: null, npcB: false },
  P3: { a: 5, b: 6, goldB: 0, relation: null, npcB: false },
  P4: { a: 7, b: 8, goldB: RICH, relation: null, npcB: false },
  P5: { a: 9, b: 10, goldB: RICH, relation: null, npcB: false },
  P6: { a: 11, b: 12, goldB: RICH, relation: null, npcB: false },
  P7: { a: 13, b: 14, goldB: RICH, relation: null, npcB: false },
  P8: { a: 15, b: 16, goldB: RICH, relation: { state: 'WAR', untilTick: 0 }, npcB: false },
  P9: { a: 17, b: 18, goldB: RICH, relation: { state: 'DECLARED', untilTick: DECLARED_UNTIL_TICK }, npcB: false },
  P10: { a: 19, b: 20, goldB: 0, relation: null, npcB: true },
} as const satisfies Record<string, { a: number; b: number; goldB: number; relation: Relation | null; npcB: boolean }>;

// 화면 사례(B10)의 국가. 쌍에 들지 않는 시나리오의 21번째 국가를 그대로 쓴다.
const SCREEN_NATION = 21;

// 사람 장수 역할. 키는 공개값이고 세션 토큰 유도에도 쓴다. N10은 NPC 국가라 사람 군주를 두지 않는다.
// p3chief는 B3 국가의 권한 없는 직위(수뇌 5)다. B3 군주의 직위는 바꾸지 않는다.
export const ACTORS = {
  p1a: { world: 'treaty', nationId: 1, officerLevel: 12 },
  p1b: { world: 'treaty', nationId: 2, officerLevel: 12 },
  p2a: { world: 'treaty', nationId: 3, officerLevel: 12 },
  p2b: { world: 'treaty', nationId: 4, officerLevel: 12 },
  p3a: { world: 'treaty', nationId: 5, officerLevel: 12 },
  p3b: { world: 'treaty', nationId: 6, officerLevel: 12 },
  p3chief: { world: 'treaty', nationId: 6, officerLevel: 5 },
  p4a: { world: 'treaty', nationId: 7, officerLevel: 12 },
  p4b: { world: 'treaty', nationId: 8, officerLevel: 12 },
  p5a: { world: 'treaty', nationId: 9, officerLevel: 12 },
  p5b: { world: 'treaty', nationId: 10, officerLevel: 12 },
  p6a: { world: 'treaty', nationId: 11, officerLevel: 12 },
  p7a: { world: 'treaty', nationId: 13, officerLevel: 12 },
  p7b: { world: 'treaty', nationId: 14, officerLevel: 12 },
  p8a: { world: 'treaty', nationId: 15, officerLevel: 12 },
  p8b: { world: 'treaty', nationId: 16, officerLevel: 12 },
  p9a: { world: 'treaty', nationId: 17, officerLevel: 12 },
  p9b: { world: 'treaty', nationId: 18, officerLevel: 12 },
  p10a: { world: 'treaty', nationId: 19, officerLevel: 12 },
  screen: { world: 'treaty', nationId: SCREEN_NATION, officerLevel: 12 },
  legacy: { world: 'legacy', nationId: 1, officerLevel: 12 },
} as const satisfies Record<string, { world: 'treaty' | 'legacy'; nationId: number; officerLevel: number }>;
export type ActorKey = keyof typeof ACTORS;

// 세션 토큰은 실행마다 새로 정한 시드에서 역할 키로 유도한다. 시드는 실행 드라이버가 자식 프로세스 env로만 넘긴다.
// 드라이버는 같은 시드로 모든 토큰과 비밀번호를 메모리에서 알 수 있어 산출물에 새지 않았는지 검사한다. 디스크에 storageState를 쓰지 않는다.
// env가 없으면(일반 pnpm e2e) 이 프로세스 안에서만 시드를 만든다.
export const AUTH_SEED_ENV = 'E2E_TREATY_AUTH_SEED';
let localSeed: Buffer | undefined;
function authSeed(): Buffer {
  const raw = process.env[AUTH_SEED_ENV];
  if (raw === undefined) return (localSeed ??= randomBytes(32));
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new Error('조약 시험 인증 시드 형식을 확인하세요.');
  return Buffer.from(raw, 'base64url');
}
// 32바이트 base64url 43자. 서버 authenticate의 토큰 형식과 같다.
const sessionToken = (key: ActorKey) =>
  createHmac('sha256', authSeed()).update(`t207-first3/session/${key}`).digest('base64url');
const fixturePassword = () => createHmac('sha256', authSeed()).update('t207-first3/password').digest('base64url');

export interface Actor {
  key: ActorKey;
  userId: string;
  generalId: number;
  nationId: number;
  worldId: string;
  context: BrowserContext;
  page: Page;
  // 앱 출처가 아닌 곳으로 나간 요청의 출처. 외부 서비스를 쓰지 않았음을 확인한다.
  external: string[];
}

export interface StoredEvent {
  id: bigint;
  kind: string;
  idempotencyKey: string;
  status: string;
  generalId: number | null;
  userId: string | null;
  result: unknown;
}

export interface StoredTreaty {
  id: number;
  fromNationId: number;
  toNationId: number;
  status: string;
  startTick: number | null;
  endTick: number | null;
  costFrom: number | null;
  costTo: number | null;
}

export type Clause = { kind: 'peace' } | { kind: 'nonAggression'; months: number } | { kind: 'note'; text: string };

type ToGameDate = (startYear: number, tick: number) => { year: number; month: number };

// 1030 시나리오의 국가 1~20을 쌍에 쓴다. 쌍 밖의 시나리오 관계는 지우고 정한 관계만 둔다.
function shapeWorld(initial: WorldInit): WorldInit {
  const state = structuredClone(initial);
  const plan = new Map<number, { gold: number; isNpc: boolean }>();
  const relations: WorldInit['diplomacies'] = [];
  for (const pair of Object.values(PAIRS)) {
    plan.set(pair.a, { gold: RICH, isNpc: false });
    plan.set(pair.b, { gold: pair.goldB, isNpc: pair.npcB });
    if (pair.relation) relations.push({ nationA: pair.a, nationB: pair.b, ...pair.relation });
  }
  for (const id of [...plan.keys(), SCREEN_NATION]) {
    if (!state.nations.some((n) => n.id === id)) throw new Error(`시나리오에 국가 ${id}가 없습니다.`);
    if (!state.cities.some((c) => c.nationId === id)) throw new Error(`국가 ${id}에 도시가 없습니다.`);
  }
  state.nations = state.nations.map((n) => {
    const wanted = plan.get(n.id);
    return wanted ? { ...n, gold: wanted.gold, isNpc: wanted.isNpc } : n;
  });
  state.diplomacies = relations;
  state.generals = state.generals.map((g) => ({ ...g, nextTurnTick: FIRST_DUE_TICK }));
  return state;
}

function note(type: string, description: string) {
  test.info().annotations.push({ type, description });
}

export class TreatyFixture {
  private passwordHash: Promise<string> | undefined;
  private readonly actors = new Map<ActorKey, Actor>();

  private constructor(
    readonly db: PrismaClient,
    readonly runId: string,
    readonly treatyWorldId: string,
    readonly legacyWorldId: string,
    readonly startYear: number,
    private readonly names: ReadonlyMap<number, string>,
    private readonly toGameDate: ToGameDate,
  ) {}

  // 두 월드를 만들고 형식을 DB에서 확인한 뒤 실제 controlClock으로 시작한다.
  static async open(): Promise<TreatyFixture> {
    const [{ createDb }, { loadInitialWorld }, { saveInitialWorld }, { controlClock }, rules] = await Promise.all([
      import('../packages/db/src/index'),
      import('../apps/engine/src/world/resources'),
      import('../apps/engine/src/world/persistence'),
      import('../apps/engine/src/world/clock'),
      import('../packages/rules/src/index'),
    ]);
    const db = createDb(e2eDatabaseUrl());
    try {
      const runId = randomUUID();
      const state = shapeWorld(await loadInitialWorld({ scenario: '1030', map: 'che', seed: `t207-first3-${runId}` }));
      const common = { turnTermMinutes: TURN_TERM_MINUTES, endYear: null, replayFormat: 'legacy' } as const;
      const treaty = await saveInitialWorld(db, structuredClone(state), {
        ...common,
        name: `첫 세 조항 시험 ${runId.slice(0, 8)}`,
        treatyFormat: 1,
      });
      const legacy = await saveInitialWorld(db, structuredClone(state), {
        ...common,
        name: `형식 1 대조 ${runId.slice(0, 8)}`,
      });

      const t = await db.world.findUniqueOrThrow({ where: { id: treaty.worldId } });
      const l = await db.world.findUniqueOrThrow({ where: { id: legacy.worldId } });
      expect(t.treatyFormat).toBe(1);
      expect(t.policyFromSequence).toBeNull();
      expect(rules.selectWorldCapabilities(t).kind).toBe('caps');
      expect(t.replayOrigin).toMatchObject({ version: 6, capabilities: { version: 1, treaty: { version: 1 } } });
      expect(l.treatyFormat).toBeNull();
      expect(l.policyFromSequence).toBeNull();
      expect(rules.selectWorldCapabilities(l).kind).toBe('legacy');
      expect(l.replayOrigin).toMatchObject({ version: 1 });
      expect(l.replayOrigin).not.toHaveProperty('capabilities');

      // 저장된 국고·NPC 여부·관계가 계획과 같은지 읽어 본다.
      const nations = await db.nation.findMany({ where: { worldId: t.id }, orderBy: { id: 'asc' } });
      for (const pair of Object.values(PAIRS)) {
        expect(nations.find((n) => n.id === pair.a)).toMatchObject({ gold: RICH, isNpc: false });
        expect(nations.find((n) => n.id === pair.b)).toMatchObject({ gold: pair.goldB, isNpc: pair.npcB });
      }
      const relations = await db.diplomacy.findMany({
        where: { worldId: t.id },
        orderBy: [{ nationA: 'asc' }, { nationB: 'asc' }],
        select: { nationA: true, nationB: true, state: true, untilTick: true },
      });
      expect(relations).toEqual(state.diplomacies);

      await controlClock(db, t.id, 'start');
      await controlClock(db, l.id, 'start');
      note('fixture-world', `조약 월드 ${t.id}, 대조 월드 ${l.id}`);
      return new TreatyFixture(
        db,
        runId,
        t.id,
        l.id,
        t.startYear,
        new Map(nations.map((n) => [n.id, n.name] as const)),
        rules.toGameDate,
      );
    } catch (error) {
      await db.$disconnect();
      throw error;
    }
  }

  // 실행 중인 감독이 두 월드의 엔진을 띄워 실행권을 잡고 heartbeat를 쓸 때까지 읽기만 하며 기다린다.
  // 제한 시간은 따로 두지 않는다. hook의 기본 제한 시간 안에 준비되지 않으면 실패로 남는다.
  async waitEngines(): Promise<void> {
    const { HEARTBEAT_MS } = await import('../apps/engine/src/main');
    for (const worldId of [this.treatyWorldId, this.legacyWorldId]) {
      for (;;) {
        const rows = await this.db.$queryRaw<Array<{ ready: boolean }>>`
          SELECT w.status = 'RUNNING'
            AND h."lastError" IS NULL
            AND h."at" > clock_timestamp() - ${HEARTBEAT_MS * 2} * interval '1 millisecond'
            AND l."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC') AS ready
          FROM "World" w
          JOIN "EngineHeartbeat" h ON h."worldId" = w.id
          JOIN "EngineLease" l ON l."worldId" = w.id
          WHERE w.id = ${worldId}`;
        if (rows[0]?.ready === true) break;
        await delay(500);
      }
    }
    note('engine-ready', '두 월드 모두 감독이 띄운 엔진의 실행권과 최근 heartbeat를 읽었다');
  }

  nationName(id: number): string {
    const name = this.names.get(id);
    if (name === undefined) throw new Error(`국가 ${id}의 이름이 없습니다.`);
    return name;
  }

  // 화면의 formatYearMonth와 같은 모양.
  yearMonth(tick: number): string {
    const date = this.toGameDate(this.startYear, tick);
    return `${date.year}년 ${date.month}월`;
  }

  // 계정과 세션은 DB에 바로 만들고 장수는 실제 general.create로 만든다. 소속·직위·첫 턴은 기존 officer()처럼 DB에서 정한다.
  // 브라우저 컨텍스트는 필요할 때 하나씩 연다.
  async actor(browser: Browser, key: ActorKey): Promise<Actor> {
    const existing = this.actors.get(key);
    if (existing) return existing;
    const plan = ACTORS[key];
    const worldId = plan.world === 'treaty' ? this.treatyWorldId : this.legacyWorldId;
    const [{ hashPassword }, { hashToken, newSession }] = await Promise.all([
      import('../apps/server/src/auth/password'),
      import('../apps/server/src/auth/session'),
    ]);
    this.passwordHash ??= hashPassword(fixturePassword());
    const token = sessionToken(key);
    const user = await this.db.user.create({
      data: {
        email: `t207f1-${key}-${this.runId}@example.invalid`,
        passwordHash: await this.passwordHash,
        sessions: { create: { id: hashToken(token), expiresAt: newSession(Date.now()).expiresAt } },
      },
      select: { id: true },
    });
    const context = await browser.newContext();
    try {
      await context.addCookies([{ name: 'sid', value: token, url: appOrigin(), httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      const external: string[] = [];
      const appHost = new URL(appOrigin()).host;
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (WEB_PROTOCOLS.includes(url.protocol) && url.host !== appHost) external.push(url.origin);
      });
      const general = await createGeneralByApi(page, worldId);
      await this.assignGeneral(key, worldId, general.id);
      const home = await query<{ nation: { id: number } | null }>(page, 'home.get', { worldId });
      expect(home.nation?.id).toBe(plan.nationId);
      const actor: Actor = {
        key,
        userId: user.id,
        generalId: general.id,
        nationId: plan.nationId,
        worldId,
        context,
        page,
        external,
      };
      this.actors.set(key, actor);
      return actor;
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  // 엔진 TurnLoop과 같은 World 행 잠금을 잡고 바꾼다. 잠금 없이 바꾸면 엔진이 먼저 읽은 장수 행으로 되돌릴 수 있다 (e2e/world.ts).
  private async assignGeneral(key: ActorKey, worldId: string, generalId: number) {
    const { nationId, officerLevel } = ACTORS[key];
    const nation = await this.db.nation.findUniqueOrThrow({
      where: { worldId_id: { worldId, id: nationId } },
      select: { capitalCityKey: true },
    });
    if (nation.capitalCityKey === null) throw new Error(`국가 ${nationId}의 수도가 없습니다.`);
    const capital = nation.capitalCityKey;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      await tx.general.update({
        where: { worldId_id: { worldId, id: generalId } },
        data: { nationId, officerLevel, cityKey: capital, nextTurnTick: FIRST_DUE_TICK },
      });
    });
    note(
      'fixture-write',
      `${key}: 장수 ${generalId}를 국가 ${nationId}의 직위 ${officerLevel}로 두고 첫 턴을 ${FIRST_DUE_TICK}로 미룸`,
    );
  }

  // B5 전용. 화면이 수락 가능 안내를 받은 뒤 받은 국가의 국고만 비운다.
  async emptyTreasury(nationId: number): Promise<void> {
    const worldId = this.treatyWorldId;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
      await tx.nation.update({ where: { worldId_id: { worldId, id: nationId } }, data: { gold: 0 } });
    });
    note('fixture-write', `국가 ${nationId}의 국고를 0으로 비움`);
  }

  expectNoExternal(actor: Actor) {
    expect(actor.external, `${actor.key} 화면이 외부 출처로 요청했습니다.`).toEqual([]);
  }

  async closeActors(...keys: ActorKey[]): Promise<void> {
    for (const key of keys) {
      const actor = this.actors.get(key);
      if (!actor) continue;
      this.actors.delete(key);
      this.expectNoExternal(actor);
      await actor.context.close();
    }
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const actor of [...this.actors.values()]) {
      this.actors.delete(actor.key);
      await actor.context.close().catch((error: unknown) => errors.push(error));
    }
    await this.db.$disconnect().catch((error: unknown) => errors.push(error));
    if (errors.length > 0) throw new Error(`조약 fixture 정리 실패 ${errors.length}건`);
  }

  // 아래는 모두 읽기다.
  async eventsByKey(idempotencyKey: string): Promise<StoredEvent[]> {
    return this.db.inputEvent.findMany({
      where: { worldId: this.treatyWorldId, idempotencyKey },
      select: EVENT_FIELDS,
    });
  }

  async eventCount(where: { generalId?: number; kinds?: string[] } = {}): Promise<number> {
    return this.db.inputEvent.count({
      where: {
        worldId: this.treatyWorldId,
        ...(where.generalId === undefined ? {} : { generalId: where.generalId }),
        ...(where.kinds === undefined ? {} : { kind: { in: where.kinds } }),
      },
    });
  }

  async treatyCount(): Promise<number> {
    return this.db.treaty.count({ where: { worldId: this.treatyWorldId } });
  }

  async treaty(id: number): Promise<StoredTreaty | null> {
    return this.db.treaty.findUnique({
      where: { worldId_id: { worldId: this.treatyWorldId, id } },
      select: {
        id: true,
        fromNationId: true,
        toNationId: true,
        status: true,
        startTick: true,
        endTick: true,
        costFrom: true,
        costTo: true,
      },
    });
  }

  async relation(x: number, y: number) {
    return this.db.diplomacy.findUnique({
      where: {
        worldId_nationA_nationB: { worldId: this.treatyWorldId, nationA: Math.min(x, y), nationB: Math.max(x, y) },
      },
      select: { state: true, untilTick: true },
    });
  }
}

// 준비 단계의 제안. 실제 HTTP로 보내고 엔진이 처리할 때까지 같은 requestId로 결과를 묻는다.
export async function proposeByHttp(
  actor: Actor,
  toNationId: number,
  clauses: Clause[],
): Promise<{ requestId: string; treatyId: number }> {
  const requestId = randomUUID();
  type State = { status: string; outcome?: string; treatyId?: string };
  let state = await mutate<State>(actor.page, 'treaty.propose', {
    worldId: actor.worldId,
    requestId,
    toNationId,
    clauses,
  });
  if (state.status === 'pending')
    await expect
      .poll(async () => {
        state = await query<State>(actor.page, 'treaty.request', { worldId: actor.worldId, requestId });
        return state.status;
      })
      .toBe('applied');
  expect(state).toMatchObject({ status: 'applied', outcome: 'PROPOSED' });
  return { requestId, treatyId: Number(state.treatyId) };
}

export interface TrpcCall {
  method: string;
  procedure: string;
  input: unknown;
}

// httpBatchLink 모양(/trpc/a,b?batch=1, 입력은 {"0": …})과 단일 호출 모양을 모두 풀어 절차 하나씩 돌려준다.
export function trpcCalls(request: Request): TrpcCall[] {
  const url = new URL(request.url());
  if (!url.pathname.startsWith('/trpc/')) return [];
  const procedures = decodeURIComponent(url.pathname.slice('/trpc/'.length)).split(',');
  const batch = url.searchParams.get('batch') === '1';
  const method = request.method();
  let raw: unknown;
  try {
    raw = method === 'GET' ? JSON.parse(url.searchParams.get('input') ?? 'null') : request.postDataJSON();
  } catch {
    raw = undefined;
  }
  return procedures.map((procedure, i) => ({
    method,
    procedure,
    input: batch && raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[String(i)] : raw,
  }));
}

// 화면이 보내는 tRPC 호출을 순서대로 모은다.
export function watchTrpc(page: Page): TrpcCall[] {
  const calls: TrpcCall[] = [];
  page.on('request', (request) => calls.push(...trpcCalls(request)));
  return calls;
}

export const requestIdsOf = (calls: readonly TrpcCall[], method: string, procedure: string) =>
  calls
    .filter((c) => c.method === method && c.procedure === procedure)
    .map((c) => (c.input as { requestId?: unknown } | undefined)?.requestId);

type BatchBody = Array<{ result?: { data?: { status?: unknown } } }>;
type Dropped = { requestId: string; httpStatus?: number; serverStatus?: unknown; fetchError?: string };

// 화면의 첫 mutation 하나만 실제 서버에 보내 응답까지 받은 뒤 브라우저에는 연결이 끊긴 것으로 보인다.
// 꾸민 응답을 돌려주지 않는다. 그 뒤의 요청은 그대로 통과한다.
export async function dropFirstResponse(page: Page, procedure: 'treaty.propose' | 'treaty.respond') {
  let dropped: Dropped | undefined;
  const shapeErrors: string[] = [];
  const matcher = (url: URL) => url.pathname === `/trpc/${procedure}`;
  const handler = async (route: Route) => {
    const request = route.request();
    if (dropped !== undefined || request.method() !== 'POST') return route.fallback();
    const calls = trpcCalls(request);
    const requestId = (calls[0]?.input as { requestId?: unknown } | undefined)?.requestId;
    if (calls.length !== 1 || typeof requestId !== 'string') {
      // 모양이 다르면 가로채지 않는다. 시험은 shapeErrors로 실패한다.
      shapeErrors.push(`${request.method()} ${calls.map((c) => c.procedure).join(',')}`);
      return route.fallback();
    }
    const current: Dropped = { requestId };
    dropped = current;
    try {
      const response = await route.fetch();
      current.httpStatus = response.status();
      const body = (await response.json().catch(() => null)) as BatchBody | null;
      current.serverStatus = Array.isArray(body) ? body[0]?.result?.data?.status : undefined;
    } catch (error) {
      current.fetchError = error instanceof Error ? error.name : 'unknown';
    } finally {
      await route.abort('connectionreset');
    }
  };
  await page.route(matcher, handler);
  return {
    get: () => dropped,
    shapeErrors: () => [...shapeErrors],
    stop: () => page.unroute(matcher, handler),
  };
}
