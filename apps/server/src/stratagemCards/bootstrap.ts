import type { Context } from '../context';
import { PgStratagemCardsStore } from './pgStore';
import { readStratagemCardsBoard, readStratagemCardsRequest, submitStratagemCardsRequest } from './service';

export function stratagemCardsService(ctx: Pick<Context, 'db' | 'now' | 'sessionId'> & { user: { id: string } }) {
  const started = performance.now();
  const store = new PgStratagemCardsStore(ctx.db, () => new Date(ctx.now + performance.now() - started));
  const identity = { userId: ctx.user.id, sessionId: ctx.sessionId ?? '' };
  return {
    mine: (value: unknown) => readStratagemCardsBoard(store, identity, value),
    request: (value: unknown) => readStratagemCardsRequest(store, identity, value),
    setTrap: (value: unknown) => submitStratagemCardsRequest(store, identity, value),
  };
}
