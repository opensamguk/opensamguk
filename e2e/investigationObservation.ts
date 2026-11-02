import { createHash } from 'node:crypto';

type Renewal = { done: AbortController; renewal: Promise<void>; lost?: unknown };

export async function settleInvestigationRenewals(holds: readonly Renewal[]): Promise<void> {
  for (const hold of holds) hold.done.abort();
  const results = await Promise.allSettled(
    holds.map(async (hold) => {
      await hold.renewal;
      if (hold.lost) throw hold.lost;
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, '조사 고정물의 리스 갱신 정착 실패');
}

export function investigationFootprint() {
  const hash = createHash('sha256');
  const tables: Array<{ table: string; sha256: string }> = [];
  return {
    table(name: string, body: string) {
      hash.update(name + ':' + body + '\n');
      tables.push({ table: name, sha256: createHash('sha256').update(body).digest('hex') });
    },
    finish() {
      return { hash: hash.digest('hex'), tables };
    },
  };
}
