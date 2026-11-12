import type { PrismaClient } from '@opensamguk/db';

export async function purgeExpiredAccountRecords(db: PrismaClient) {
  const [result] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT public.purge_expired_account_records() AS count
  `;
  return result!.count;
}

export function startAccountRetention(db: PrismaClient, failed: () => void) {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const run = async () => {
    let delay = 60 * 60 * 1000;
    try {
      if ((await purgeExpiredAccountRecords(db)) === 100) delay = 1000;
    } catch {
      failed();
    } finally {
      if (!stopping) {
        timer = setTimeout(() => {
          active = run();
        }, delay);
        timer.unref();
      }
    }
  };
  active = run();
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await active;
    },
  };
}
