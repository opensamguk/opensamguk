import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export { PrismaClient };
export type { Prisma } from './generated/prisma/client';
export {
  readPublishedResources,
  type GameResourceKind,
  type GameResourceRef,
  type PublishedResource,
} from './gameResources';
export { nextActionSequence } from './inputEvents';
export { readWorldExtRows, writeWorldExtChanges } from './worldExt';
export { assertStorableJson, type StorableJson } from './storableJson';
export { notifyWorld, notifySessionClosed, worldChannel, type RealtimeSignal, type RealtimeTarget } from './realtime';

export function createDb(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
