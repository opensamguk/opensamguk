import { createDb } from '@opensamguk/db';

export function createServerDb(connectionString: string) {
  return createDb(connectionString, { transactionOptions: { maxWait: 10_000 } });
}
