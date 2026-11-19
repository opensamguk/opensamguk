import { expect, it, vi } from 'vitest';
import { createDb } from '@opensamguk/db';
import { buildServer } from './server';

it.each([
  ['Unable to start a transaction in the given time.', 'maxWait'],
  ['A commit cannot be executed on an expired transaction.', 'timeout'],
])('logs a safe P2028 category: %s', async (message, category) => {
  const db = createDb('postgresql://unused:unused@127.0.0.1:1/unused');
  const logs: string[] = [];
  vi.spyOn(db, '$transaction').mockRejectedValue(
    Object.assign(new Error(`${message} private-marker`), { code: 'P2028' }),
  );
  const app = await buildServer({
    db,
    production: false,
    capacityMonitor: null,
    loginAudit: null,
    logStream: {
      write: (chunk) => {
        logs.push(String(chunk));
      },
    },
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/trpc/lobby.worlds' });
    expect(response.statusCode).toBe(500);
    const failure = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === 'tRPC 요청 실패');
    expect(failure).toMatchObject({ transactionFailure: category, diagnostic: { code: 'P2028' } });
    expect(logs.join('')).not.toContain('private-marker');
    expect(response.payload).not.toMatch(/private-marker|transactionFailure|P2028/);
  } finally {
    await app.close();
    await db.$disconnect();
    vi.restoreAllMocks();
  }
});
