import type { PrismaClient } from '@opensamguk/db';
import type { BigIntStatsFs } from 'node:fs';
import { isAbsolute } from 'node:path';
import { normalizeDiscordWebhookUrl } from '../notifications/discordWebhook';

export const CAPACITY_POLL_MS = 5 * 60_000;
export const CAPACITY_REPEAT_MS = 30 * 60_000;
export const CAPACITY_READ_MS = 10_000;
export type CapacityLevel = 'healthy' | 'warning' | 'critical' | 'unavailable';
export type CapacitySample = Readonly<{
  level: CapacityLevel;
  bytes?: string;
  totalBytes?: string;
  usedPercent?: number;
}>;
export type DiskSpace = Pick<BigIntStatsFs, 'blocks' | 'bsize' | 'bfree' | 'bavail'>;

export class CapacityMonitorConfig {
  readonly #paths: readonly string[];
  readonly #databaseWarnBytes: bigint;
  readonly #webhook: string;

  constructor(paths: readonly string[], databaseWarnBytes: bigint, webhook: string) {
    if (
      paths.length < 1 ||
      paths.length > 16 ||
      paths.some(
        (path) =>
          !isAbsolute(path) ||
          path.length > 4096 ||
          [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
      ) ||
      new Set(paths).size !== paths.length ||
      databaseWarnBytes <= 0n ||
      !normalizeDiscordWebhookUrl(webhook)
    )
      throw new Error('운영 용량 감시 설정을 확인하세요.');
    this.#paths = Object.freeze([...paths]);
    this.#databaseWarnBytes = databaseWarnBytes;
    this.#webhook = webhook;
  }

  get paths(): readonly string[] {
    return this.#paths;
  }
  get databaseWarnBytes(): bigint {
    return this.#databaseWarnBytes;
  }
  get webhook(): string {
    return this.#webhook;
  }
}

export function readCapacityConfig(env: NodeJS.ProcessEnv): CapacityMonitorConfig | null {
  if (env.CAPACITY_MONITOR_ENABLED === undefined || env.CAPACITY_MONITOR_ENABLED === '0') return null;
  if (env.CAPACITY_MONITOR_ENABLED !== '1') throw new Error('운영 용량 감시 설정을 확인하세요.');
  let paths: unknown;
  try {
    paths = JSON.parse(env.MONITOR_DISK_PATHS ?? '');
  } catch {
    throw new Error('운영 용량 감시 설정을 확인하세요.');
  }
  const threshold = env.DB_SIZE_WARN_BYTES;
  if (
    !Array.isArray(paths) ||
    !paths.every((path): path is string => typeof path === 'string') ||
    threshold === undefined ||
    !/^[1-9][0-9]{0,29}$/.test(threshold)
  )
    throw new Error('운영 용량 감시 설정을 확인하세요.');
  return new CapacityMonitorConfig(paths, BigInt(threshold), env.OPS_DISCORD_WEBHOOK_URL ?? '');
}

export function evaluateDiskCapacity(space: DiskSpace): CapacitySample {
  const { bsize, blocks, bfree, bavail } = space;
  if (
    [bsize, blocks, bfree, bavail].some((value) => typeof value !== 'bigint') ||
    bsize <= 0n ||
    blocks <= 0n ||
    bfree < 0n ||
    bfree > blocks ||
    bavail < 0n ||
    bavail > bfree
  )
    throw new Error('용량 표본을 확인하지 못했습니다.');
  // 실행 계정이 쓸 수 없는 예약 공간도 사용 불가 용량에 포함한다.
  const used = blocks - bavail;
  return {
    level: used * 100n >= blocks * 90n ? 'critical' : used * 100n >= blocks * 80n ? 'warning' : 'healthy',
    bytes: (used * bsize).toString(),
    totalBytes: (blocks * bsize).toString(),
    usedPercent: Number((used * 10_000n) / blocks) / 100,
  };
}

export function evaluateDatabaseCapacity(bytes: bigint, warningBytes: bigint): CapacitySample {
  if (typeof bytes !== 'bigint' || typeof warningBytes !== 'bigint' || bytes < 0n || warningBytes <= 0n)
    throw new Error('용량 표본을 확인하지 못했습니다.');
  return { level: bytes >= warningBytes ? 'warning' : 'healthy', bytes: bytes.toString() };
}

export async function readDatabaseCapacity(db: PrismaClient): Promise<bigint> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
      const rows = await tx.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database()) AS bytes`;
      if (rows.length !== 1 || typeof rows[0]?.bytes !== 'bigint') throw new Error('DB 용량을 확인하지 못했습니다.');
      return rows[0].bytes;
    },
    { maxWait: 1000, timeout: 2000 },
  );
}
