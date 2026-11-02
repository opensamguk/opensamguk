import type { Context } from '../context';
import { PgLogisticsStore } from './pgStore';
import { readLogisticsBoard, readLogisticsRequest, submitLogisticsRequest } from './service';

export function logisticsService(ctx: Pick<Context, 'db' | 'now' | 'sessionId'> & { user: { id: string } }) {
  const started = performance.now();
  const store = new PgLogisticsStore(ctx.db, () => new Date(ctx.now + performance.now() - started));
  const identity = { userId: ctx.user.id, sessionId: ctx.sessionId ?? '' };
  return {
    get: (value: unknown) => readLogisticsBoard(store, identity, value),
    request: (value: unknown) => readLogisticsRequest(store, identity, value),
    submit: (value: unknown) => submitLogisticsRequest(store, identity, value),
  };
}
