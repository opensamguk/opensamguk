import type { PrismaClient } from '@opensamguk/db';

export interface Context {
  db: PrismaClient;
}
