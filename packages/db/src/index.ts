import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

export { PrismaClient };
export type { Prisma } from './generated/prisma/client';
export { nextActionSequence } from './inputEvents';

export function createDb(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
