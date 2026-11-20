// A 30-read burst needs three waves in the pg pool (10 connections); keep queue and snapshot budgets separate.
export const readTransactionOptions = {
  isolationLevel: 'RepeatableRead',
  maxWait: 10_000,
  timeout: 10_000,
} as const;

// Only emit a fixed category; Prisma messages can contain SQL and connection details.
export function transactionFailure(error: unknown): 'maxWait' | 'timeout' | 'other' | undefined {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'P2028') return undefined;
  const detail =
    'meta' in error && error.meta && typeof error.meta === 'object' && 'error' in error.meta
      ? error.meta.error
      : undefined;
  const message = typeof detail === 'string' ? detail : error.message;
  if (message.includes('Unable to start a transaction in the given time')) return 'maxWait';
  if (message.includes('expired transaction')) return 'timeout';
  return 'other';
}
