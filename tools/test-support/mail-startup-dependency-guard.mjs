import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

if (isMainThread) register(import.meta.url, { parentURL: import.meta.url });

const blocked = new Set([
  new URL('../../apps/server/src/server.ts', import.meta.url).href,
  new URL('../../packages/db/src/index.ts', import.meta.url).href,
]);

export async function load(url, context, nextLoad) {
  if (blocked.has(url)) throw new Error('MAIL_STARTUP_DEPENDENCY_LOADED');
  return nextLoad(url, context);
}
