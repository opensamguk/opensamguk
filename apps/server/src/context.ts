import type { PrismaClient } from '@opensamguk/db';
import type {} from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import type { createRateLimiter } from './security/rateLimit';

export interface Context {
  db: PrismaClient;
  user: { id: string; email: string } | null;
  sessionId: string | null;
  reply: FastifyReply;
  now: number;
  secureCookies: boolean;
  dummyPasswordHash: string;
  ip: string;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  closeSession?: ((sessionId: string) => void) | undefined;
}
