import { createDb } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../server';
import { countEngineHealth, ENGINE_STALE_AGE_MS, ENGINE_STALE_LAG_MS, type EngineHealthRow } from './health';

const NOW = Date.UTC(2026, 9, 24);
const PRIVATE = 'private-health-fixture';
const PUBLIC_ORIGIN = 'http://127.0.0.1:5173';
const CLOSED_DATABASE = 'postgresql://unused@127.0.0.1:1/unused';
const QUERY = {
  where: { status: { in: ['RUNNING', 'PAUSED'] } },
  select: { engineHeartbeat: { select: { at: true, lagMs: true } } },
};

function row(ageMs = 0, lagMs = 0): EngineHealthRow {
  return { engineHeartbeat: { at: new Date(NOW - ageMs), lagMs } };
}

function expectHeaders(headers: Record<string, unknown>): void {
  expect(headers['cache-control']).toBe('no-store');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('same-origin');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['set-cookie']).toBeUndefined();
  expect(headers['access-control-allow-origin']).toBeUndefined();
}

async function withFixture(use: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try {
    await use(f);
  } finally {
    try {
      for (const blocked of f.blocked) expect(blocked).not.toHaveBeenCalled();
    } finally {
      try {
        await f.app.close();
      } finally {
        await f.db.$disconnect();
        vi.restoreAllMocks();
      }
    }
  }
}

async function fixture() {
  const db = createDb(CLOSED_DATABASE);
  const clockAnswer = vi.fn<() => ReturnType<typeof db.$queryRaw>>().mockResolvedValue([{ now: new Date(NOW) }]);
  const selectAnswer = vi.fn<() => ReturnType<typeof db.$queryRaw>>().mockResolvedValue([]);
  const blocked = [
    vi.spyOn(db.session, 'findUnique').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db.session, 'updateMany').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db.engineLease, 'findUnique').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db.engineLease, 'findMany').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db.engineHeartbeat, 'findUnique').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db.engineHeartbeat, 'findMany').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db.general, 'findUnique').mockRejectedValue(new Error(PRIVATE)),
    vi.spyOn(db, '$queryRawUnsafe').mockRejectedValue(new Error(PRIVATE)),
  ];
  const raw = vi.spyOn(db, '$queryRaw').mockImplementation((query) => {
    if (!Array.isArray(query)) throw new Error(PRIVATE);
    const sql = query.join('').trim();
    if (sql === 'SELECT 1') return selectAnswer();
    if (sql === 'SELECT statement_timestamp() AS now') return clockAnswer();
    throw new Error(PRIVATE);
  });
  vi.spyOn(db.world, 'findMany');
  const findMany = vi
    .mocked(db.world.findMany<{ select: { engineHeartbeat: { select: { at: true; lagMs: true } } } }>)
    .mockResolvedValue([]);
  const data = {
    set clockRows(value: unknown) {
      clockAnswer.mockResolvedValue(value);
    },
    set rows(value: EngineHealthRow[]) {
      findMany.mockResolvedValue(value);
    },
  };
  const transaction = vi.spyOn(db, '$transaction').mockImplementation(async (callback) => {
    if (typeof callback !== 'function') throw new Error(PRIVATE);
    return callback(db);
  });
  const logs: string[] = [];
  try {
    const app = await buildServer({
      db,
      publicOrigin: PUBLIC_ORIGIN,
      now: () => NOW + 10_000_000,
      logStream: {
        write: (chunk) => {
          logs.push(String(chunk));
        },
      },
    });
    return { db, data, blocked, raw, findMany, transaction, app, logs };
  } catch (error) {
    await db.$disconnect();
    vi.restoreAllMocks();
    throw error;
  }
}

describe('AC-M3-09 engine health aggregation', () => {
  it.each([
    { name: 'empty', rows: [], expected: { worlds: 0, stale: 0 } },
    { name: 'missing heartbeat', rows: [{ engineHeartbeat: null }], expected: { worlds: 1, stale: 1 } },
    { name: 'age boundary', rows: [row(ENGINE_STALE_AGE_MS)], expected: { worlds: 1, stale: 0 } },
    { name: 'age over boundary', rows: [row(ENGINE_STALE_AGE_MS + 1)], expected: { worlds: 1, stale: 1 } },
    { name: 'lag boundary', rows: [row(0, ENGINE_STALE_LAG_MS)], expected: { worlds: 1, stale: 0 } },
    { name: 'lag over boundary', rows: [row(0, ENGINE_STALE_LAG_MS + 1)], expected: { worlds: 1, stale: 1 } },
    {
      name: 'two reasons counted once',
      rows: [row(ENGINE_STALE_AGE_MS + 1, ENGINE_STALE_LAG_MS + 1)],
      expected: { worlds: 1, stale: 1 },
    },
    { name: 'future heartbeat', rows: [row(-1)], expected: { worlds: 1, stale: 0 } },
  ])('$name', ({ rows, expected }) => {
    for (const item of rows) {
      if (item.engineHeartbeat) Object.freeze(item.engineHeartbeat);
      Object.freeze(item);
    }
    expect(countEngineHealth(NOW, Object.freeze(rows))).toEqual(expected);
  });

  it.each([NaN, Infinity, 1.5])('rejects an unreadable clock %s', (now) => {
    expect(countEngineHealth(now, [])).toBeNull();
  });

  it.each([
    ['at', new Date(NaN)],
    ['at', 'not-a-date'],
    ['lagMs', NaN],
    ['lagMs', 0.5],
  ])('rejects an unreadable %s instead of returning partial counts', (key, value) => {
    const bad = row();
    Reflect.set(bad.engineHeartbeat!, String(key), value);
    expect(countEngineHealth(NOW, [{ engineHeartbeat: null }, bad])).toBeNull();
  });
});

describe('AC-M3-09 public health routes with injected DB replies', () => {
  it('checks SELECT 1 without a transaction or world read', async () => {
    await withFixture(async ({ app, raw, transaction, findMany }) => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expectHeaders(response.headers);
      expect(raw).toHaveBeenCalledExactlyOnceWith(['SELECT 1']);
      expect(transaction).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  it('hides the DB failure in both the response and logs', async () => {
    await withFixture(async ({ app, raw, logs }) => {
      raw.mockRejectedValueOnce(new Error(PRIVATE));
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false });
      expectHeaders(response.headers);
      expect(response.payload).not.toContain(PRIVATE);
      expect(logs.join('')).not.toContain(PRIVATE);
      expect(logs.join('')).toContain('서버 상태 확인이 실패했습니다.');
    });
  });

  it('uses one DB snapshot and DB clock, with an empty active set healthy', async () => {
    await withFixture(async ({ app, raw, transaction, findMany }) => {
      const response = await app.inject({ method: 'GET', url: '/healthz/engine' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, worlds: 0, stale: 0 });
      expectHeaders(response.headers);
      expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
      expect(raw).toHaveBeenCalledExactlyOnceWith(['SELECT statement_timestamp() AS now']);
      expect(findMany).toHaveBeenCalledExactlyOnceWith(QUERY);
      expect(raw.mock.invocationCallOrder[0]).toBeLessThan(findMany.mock.invocationCallOrder[0]!);
    });
  });

  it('returns only aggregate counts for mixed readable rows', async () => {
    await withFixture(async ({ app, data, logs }) => {
      const hidden = row(ENGINE_STALE_AGE_MS + 1);
      Reflect.set(hidden, 'id', PRIVATE);
      data.rows = [{ engineHeartbeat: null }, hidden, row()];
      const response = await app.inject({ method: 'GET', url: '/healthz/engine' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, worlds: 3, stale: 2 });
      expectHeaders(response.headers);
      expect(response.payload).not.toContain(PRIVATE);
      expect(logs.join('')).not.toContain(PRIVATE);
    });
  });

  it.each([
    [ENGINE_STALE_AGE_MS, ENGINE_STALE_LAG_MS, 200, 0],
    [ENGINE_STALE_AGE_MS + 1, 0, 503, 1],
    [0, ENGINE_STALE_LAG_MS + 1, 503, 1],
    [-1, 0, 200, 0],
  ])('uses the DB boundaries age=%i lag=%i', async (age, lag, status, stale) => {
    await withFixture(async ({ app, data }) => {
      data.rows = [row(age, lag)];
      const response = await app.inject({ method: 'GET', url: '/healthz/engine' });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ ok: status === 200, worlds: 1, stale });
      expectHeaders(response.headers);
    });
  });

  it.each(['clock', 'rows', 'transaction'] as const)('reports unknown counts on %s failure', async (failure) => {
    await withFixture(async ({ app, raw, findMany, transaction, logs }) => {
      if (failure === 'clock') raw.mockRejectedValueOnce(new Error(PRIVATE));
      if (failure === 'rows') findMany.mockRejectedValueOnce(new Error(PRIVATE));
      if (failure === 'transaction') transaction.mockRejectedValueOnce(new Error(PRIVATE));
      const response = await app.inject({ method: 'GET', url: '/healthz/engine' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, worlds: null, stale: null });
      expectHeaders(response.headers);
      if (failure === 'clock') expect(findMany).not.toHaveBeenCalled();
      expect(response.payload).not.toContain(PRIVATE);
      expect(logs.join('')).not.toContain(PRIVATE);
      expect(logs.join('')).toContain('엔진 상태 확인이 실패했습니다.');
    });
  });

  it.each([
    { name: 'missing', clockRows: [] },
    { name: 'string', clockRows: [{ now: 'not-a-date' }] },
    { name: 'invalid Date', clockRows: [{ now: new Date(NaN) }] },
  ])('rejects an unreadable DB clock row $name', async ({ clockRows }) => {
    await withFixture(async ({ app, data }) => {
      data.clockRows = clockRows;
      const response = await app.inject({ method: 'GET', url: '/healthz/engine' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, worlds: null, stale: null });
      expectHeaders(response.headers);
    });
  });

  it('rejects an unreadable heartbeat without leaking partial counts', async () => {
    await withFixture(async ({ app, data }) => {
      data.rows = [{ engineHeartbeat: null }, { engineHeartbeat: { at: new Date(NaN), lagMs: 0 } }];
      const response = await app.inject({ method: 'GET', url: '/healthz/engine' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ ok: false, worlds: null, stale: null });
      expectHeaders(response.headers);
    });
  });

  it.each(['/healthz', '/healthz/engine'])('ignores Origin, sid and query for %s', async (path) => {
    await withFixture(async ({ app, data, findMany }) => {
      data.rows = [row()];
      const plain = await app.inject({ method: 'GET', url: path });
      const response = await app.inject({
        method: 'GET',
        url: `${path}?worldId=${PRIVATE}`,
        headers: { origin: 'https://outside.invalid', cookie: `sid=${'a'.repeat(64)}` },
      });
      expect(response.statusCode).toBe(plain.statusCode);
      expect(response.json()).toEqual(plain.json());
      expectHeaders(response.headers);
      if (path === '/healthz/engine') expect(findMany.mock.calls).toEqual([[QUERY], [QUERY]]);
      else expect(findMany).not.toHaveBeenCalled();
    });
  });

  it('preserves the tRPC health success envelope when its DB check fails', async () => {
    await withFixture(async ({ app, raw }) => {
      raw.mockRejectedValueOnce(new Error(PRIVATE));
      const response = await app.inject({ method: 'GET', url: '/trpc/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().result.data).toMatchObject({ server: 'ok', db: 'down' });
    });
  });
});

it('returns 503 for a closed database port without client spies', async () => {
  const db = createDb(CLOSED_DATABASE);
  const app = await buildServer({ db, publicOrigin: PUBLIC_ORIGIN, logging: false });
  try {
    const basic = await app.inject({ method: 'GET', url: '/healthz' });
    expect(basic.statusCode).toBe(503);
    expect(basic.json()).toEqual({ ok: false });
    expectHeaders(basic.headers);
    const engine = await app.inject({ method: 'GET', url: '/healthz/engine' });
    expect(engine.statusCode).toBe(503);
    expect(engine.json()).toEqual({ ok: false, worlds: null, stale: null });
    expectHeaders(engine.headers);
  } finally {
    await app.close();
    await db.$disconnect();
  }
});
