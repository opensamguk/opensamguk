import { createDb } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  CapacityMonitorConfig,
  evaluateDatabaseCapacity,
  evaluateDiskCapacity,
  readDatabaseCapacity,
  readCapacityConfig,
  type DiskSpace,
} from './capacity';

const PATH = resolve('capacity-fixture');
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/capacity_fixture';
const env = () => ({
  CAPACITY_MONITOR_ENABLED: '1',
  MONITOR_DISK_PATHS: JSON.stringify([PATH]),
  DB_SIZE_WARN_BYTES: '1000',
  OPS_DISCORD_WEBHOOK_URL: WEBHOOK,
});

it('limits DB capacity reads to a bounded read-only current database transaction', async () => {
  const db = createDb('postgresql://unused@127.0.0.1:1/unused');
  const execute = vi.spyOn(db, '$executeRaw').mockResolvedValue(0);
  const query = vi.spyOn(db, '$queryRaw').mockResolvedValue([{ bytes: 1234n }]);
  const transaction = vi.spyOn(db, '$transaction').mockImplementation(async (callback) => {
    if (typeof callback !== 'function') throw new Error('unexpected transaction form');
    return callback(db);
  });
  try {
    expect(await readDatabaseCapacity(db)).toBe(1234n);
    expect(transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 1000, timeout: 2000 });
    const sql = execute.mock.calls.map(([statement]) =>
      Array.isArray(statement) ? statement.join('') : 'unexpected SQL',
    );
    expect(sql).toEqual(['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '1500ms'"]);
    const statement = query.mock.calls[0]?.[0];
    expect(Array.isArray(statement) ? statement.join('') : '').toBe(
      'SELECT pg_database_size(current_database()) AS bytes',
    );
  } finally {
    vi.restoreAllMocks();
    await db.$disconnect();
  }
});
const space = (available: bigint): DiskSpace => ({ blocks: 100n, bsize: 4096n, bfree: available, bavail: available });

describe('opt-in capacity configuration', () => {
  it.each([undefined, '0'])('is OFF without reading inactive settings (%s)', (enabled) => {
    expect(
      readCapacityConfig({
        ...(enabled === undefined ? {} : { CAPACITY_MONITOR_ENABLED: enabled }),
        MONITOR_DISK_PATHS: 'malformed-secret',
        DB_SIZE_WARN_BYTES: 'not-a-number',
        OPS_DISCORD_WEBHOOK_URL: 'private',
      }),
    ).toBeNull();
  });
  it('keeps exact configured paths and hides private configuration in JSON', () => {
    const config = readCapacityConfig(env())!;
    expect(config.paths).toEqual([PATH]);
    expect(config.databaseWarnBytes).toBe(1000n);
    expect(config.webhook).toBe(WEBHOOK);
    expect(JSON.stringify(config)).toBe('{}');
    expect(Object.isFrozen(config.paths)).toBe(true);
  });
  it.each([
    { CAPACITY_MONITOR_ENABLED: 'true' },
    { MONITOR_DISK_PATHS: 'malformed-canary' },
    { MONITOR_DISK_PATHS: '[]' },
    { MONITOR_DISK_PATHS: '["relative"]' },
    { MONITOR_DISK_PATHS: JSON.stringify([PATH, PATH]) },
    { MONITOR_DISK_PATHS: JSON.stringify([`${PATH}\u0000`]) },
    { DB_SIZE_WARN_BYTES: '0' },
    { DB_SIZE_WARN_BYTES: '1.5' },
    { DB_SIZE_WARN_BYTES: '01' },
    { OPS_DISCORD_WEBHOOK_URL: '' },
    { OPS_DISCORD_WEBHOOK_URL: 'https://outside.invalid/private' },
  ])('rejects invalid active configuration without original values', (delta) => {
    expect(() => readCapacityConfig({ ...env(), ...delta })).toThrow(/^운영 용량 감시 설정을 확인하세요\.$/);
  });
  it('does not accept the GitHub uptime secret as an implicit server alias', () => {
    const configured = env();
    expect(() =>
      readCapacityConfig({ ...configured, OPS_DISCORD_WEBHOOK_URL: '', OPS_DISCORD_WEBHOOK: WEBHOOK }),
    ).toThrow();
  });
  it('requires an explicit positive DB threshold', () => {
    expect(() => new CapacityMonitorConfig([PATH], 0n, WEBHOOK)).toThrow();
  });
});

describe('capacity boundaries use bigint arithmetic', () => {
  it.each([
    [21n, 'healthy'],
    [20n, 'warning'],
    [11n, 'warning'],
    [10n, 'critical'],
    [0n, 'critical'],
  ])('evaluates exact available blocks %s as %s', (available, level) => {
    expect(evaluateDiskCapacity(space(available))).toMatchObject({ level, usedPercent: Number(100n - available) });
  });
  it('counts reserved blocks unavailable to the service account', () => {
    expect(evaluateDiskCapacity({ ...space(20n), bfree: 30n })).toMatchObject({
      level: 'warning',
      bytes: '327680',
      totalBytes: '409600',
    });
  });
  it('handles sizes beyond Number safe integer without rounding the threshold', () => {
    const blocks = 10n ** 30n;
    expect(
      evaluateDiskCapacity({ blocks, bsize: 4096n, bfree: blocks / 5n + 1n, bavail: blocks / 5n + 1n }).level,
    ).toBe('healthy');
    expect(evaluateDiskCapacity({ blocks, bsize: 4096n, bfree: blocks / 5n, bavail: blocks / 5n }).level).toBe(
      'warning',
    );
  });
  it.each([
    { blocks: 0n },
    { bsize: 0n },
    { bavail: -1n },
    { bavail: 101n },
    { bfree: 101n },
    { bfree: 19n, bavail: 20n },
  ])('rejects unknown or impossible filesystem capacity', (delta) => {
    expect(() => evaluateDiskCapacity({ ...space(20n), ...delta })).toThrow('용량 표본을 확인하지 못했습니다.');
  });
  it('evaluates DB bytes at the explicit threshold and accepts zero used bytes', () => {
    expect(evaluateDatabaseCapacity(999n, 1000n).level).toBe('healthy');
    expect(evaluateDatabaseCapacity(1000n, 1000n).level).toBe('warning');
    expect(evaluateDatabaseCapacity(0n, 1n).level).toBe('healthy');
    expect(() => evaluateDatabaseCapacity(-1n, 1n)).toThrow();
    expect(() => evaluateDatabaseCapacity(1n, 0n)).toThrow();
  });
});
