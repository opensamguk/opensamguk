import { publicMapConfig } from '@opensamguk/shared';
import { parseArgs } from 'node:util';
import { createDb } from '@opensamguk/db';
import { engineFailureMessage, runEngine } from './main';
import { runSupervisor } from './supervisor';

async function main() {
  publicMapConfig(process.env);
  const { values } = parseArgs({ options: { world: { type: 'string' } } });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
  const db = createDb(process.env.DATABASE_URL);
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    console.log('[engine] 시작');
    if (values.world) {
      await runEngine(db, {
        worldId: values.world,
        signal: controller.signal,
        onStatus: (status) => console.log(`[engine] ${status}`),
      });
    } else {
      await runSupervisor(db, {
        signal: controller.signal,
        onEvent: (event) => console.log(`[supervisor] ${event.kind}`),
      });
    }
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await db.$disconnect();
    console.log('[engine] 종료');
  }
}

main().catch((error: unknown) => {
  console.error(engineFailureMessage(error));
  process.exitCode = 1;
});
