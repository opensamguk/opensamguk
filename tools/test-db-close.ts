import { setTimeout as delay } from 'node:timers/promises';

type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

type DisconnectFailure = 'query-failed' | 'invalid-count' | 'still-connected' | 'identity-changed';
const messages: Record<DisconnectFailure, string> = {
  'query-failed': '시험 DB 상태를 조회하지 못했습니다.',
  'invalid-count': '시험 DB 연결 수를 확인하지 못했습니다.',
  'still-connected': '시험 DB 연결이 남아 DB를 보존합니다.',
  'identity-changed': '시험 DB 식별자가 달라 DB를 보존합니다.',
};

export class DatabaseDisconnectError extends Error {
  constructor(
    readonly reason: DisconnectFailure,
    readonly connections?: number,
  ) {
    super(messages[reason]);
  }
}

async function readObservation(read: () => Promise<unknown>) {
  try {
    return await read();
  } catch {
    throw new DatabaseDisconnectError('query-failed');
  }
}

// 연결 종료가 서버에 반영됐고 이름이 같은 자기 DB인지 삭제 직전에 확인한다. 조회 시간은 지연 합계에 포함되지 않는다.
export async function observeDisconnectedDatabase(
  name: string,
  oid: string,
  readCount: () => Promise<unknown>,
  readOid: () => Promise<unknown>,
) {
  if (!/^[a-z][a-z0-9_]*_test$/.test(name) || !/^[1-9]\d*$/.test(oid))
    throw new Error('자기 시험 DB 식별자를 확인하세요.');
  let connections: number | undefined,
    initialConnections: number | undefined,
    observations = 0;
  for (; observations <= 30; observations++) {
    const value = await readObservation(readCount);
    connections =
      typeof value === 'number' || (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) ? Number(value) : NaN;
    if (!Number.isSafeInteger(connections) || connections! < 0) throw new DatabaseDisconnectError('invalid-count');
    initialConnections ??= connections;
    if (connections === 0 || observations === 30) break;
    await delay(100);
  }
  if (connections !== 0) throw new DatabaseDisconnectError('still-connected', connections);
  if ((await readObservation(readOid)) !== oid) throw new DatabaseDisconnectError('identity-changed');
  return { initialConnections, observations, connections };
}

export async function confirmDisconnectedDatabase(client: Client, name: string, oid: string) {
  return observeDisconnectedDatabase(
    name,
    oid,
    async () => {
      const { rows } = await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [
        name,
      ]);
      return rows.length === 1 ? rows[0]!.count : undefined;
    },
    async () => {
      const { rows } = await client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name]);
      return rows.length === 1 ? rows[0]!.oid : undefined;
    },
  );
}
