import type { Context } from '../context';
import { PgLineageStore } from './pgStore';
import { readLineageBoard, readLineageRequest, submitLineageRequest } from './service';

export function lineageService(ctx: Pick<Context, 'db' | 'now' | 'sessionId'> & { user: { id: string } }) {
  const started = performance.now();
  const store = new PgLineageStore(ctx.db, () => new Date(ctx.now + performance.now() - started));
  const identity = { userId: ctx.user.id, sessionId: ctx.sessionId ?? '' };
  return {
    get: (value: unknown) => readLineageBoard(store, identity, value),
    request: (value: unknown) => readLineageRequest(store, identity, value),
    submit: (value: unknown) => submitLineageRequest(store, identity, value),
  };
}
