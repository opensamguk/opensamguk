import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDb } from '@opensamguk/db';
import { buildServer } from './server';

it('logs the failing procedure and schema cause without exposing inputs in logs or HTTP', async () => {
  const db = createDb('postgresql://unused:unused@127.0.0.1:1/unused');
  const logs: string[] = [];
  const invalid = z.object({ sex: z.enum(['MALE', 'FEMALE', 'UNKNOWN']) }).safeParse({ sex: 'private-marker' });
  if (invalid.success) throw new Error('expected invalid fixture');
  vi.spyOn(db, '$transaction').mockRejectedValue(invalid.error);
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
    expect(failure).toMatchObject({
      path: 'lobby.worlds',
      diagnostic: { name: 'ZodError', issues: [{ code: 'invalid_value', path: ['[field]'] }] },
    });
    expect(logs.join('')).not.toContain('private-marker');
    expect(response.payload).not.toMatch(/private-marker|ZodError|diagnostic/);
  } finally {
    await app.close();
    await db.$disconnect();
    vi.restoreAllMocks();
  }
});
