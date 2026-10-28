import { setTimeout as delay } from 'node:timers/promises';

type Client = { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

// 연결 종료가 서버에 반영됐고 이름이 같은 자기 DB인지 삭제 직전에 확인한다.
export async function confirmDisconnectedDatabase(client: Client, name: string, oid: string) {
  if (!/^[a-z][a-z0-9_]*_test$/.test(name) || !/^[1-9]\d*$/.test(oid))
    throw new Error('자기 시험 DB 식별자를 확인하세요.');
  let connections: number | undefined,
    initialConnections: number | undefined,
    observations = 0;
  for (; observations <= 30; observations++) {
    const rows = (await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [name]))
      .rows;
    connections = rows.length === 1 ? Number(rows[0]!.count) : NaN;
    if (!Number.isSafeInteger(connections) || connections! < 0)
      throw new Error('시험 DB 연결 수를 확인하지 못했습니다.');
    initialConnections ??= connections;
    if (connections === 0 || observations === 30) break;
    await delay(100);
  }
  if (connections !== 0) throw new Error('시험 DB 연결이 남아 DB를 보존합니다.');
  const identity = (await client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1', [name])).rows;
  if (identity.length !== 1 || identity[0]!.oid !== oid) throw new Error('시험 DB 식별자가 달라 DB를 보존합니다.');
  return { initialConnections, observations, connections };
}
