import type { Context } from '../context';
import { PgGovernanceStore } from './pgStore';
import { readGovernanceBoard, readGovernanceRequest, submitGovernanceRequest } from './service';

export function governanceService(ctx: Pick<Context, 'db' | 'now' | 'sessionId'> & { user: { id: string } }) {
  const started = performance.now();
  const store = new PgGovernanceStore(ctx.db, () => new Date(ctx.now + performance.now() - started));
  const identity = { userId: ctx.user.id, sessionId: ctx.sessionId ?? '' };
  return {
    get: (value: unknown) => readGovernanceBoard(store, identity, value),
    request: (value: unknown) => readGovernanceRequest(store, identity, value),
    submit: (value: unknown) => submitGovernanceRequest(store, identity, value),
  };
}
