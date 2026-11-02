import type { PublicMapConfig } from '@opensamguk/shared';
import type { PrismaClient } from '@opensamguk/db';
import type {} from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import type { createRateLimiter } from './security/rateLimit';
import type { MailTransport } from './mail/transport';
import type { LegalPolicy } from './legal/policy';
import type { WithdrawalPolicy } from './auth/withdrawalPolicy';
import type { LoginAuditRequest } from './auth/loginAudit';

export interface Context {
  db: PrismaClient;
  publicMapConfig: PublicMapConfig;
  user: { id: string; email: string } | null;
  sessionId: string | null;
  reply: FastifyReply;
  now: number;
  secureCookies: boolean;
  dummyPasswordHash: string;
  ip: string;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  accountMail?: { transport: MailTransport; origin: string } | undefined;
  emailVerificationRequired?: boolean | undefined;
  legalPolicy?: LegalPolicy | null | undefined;
  legalPolicyRequired?: boolean | undefined;
  withdrawalPolicy?: WithdrawalPolicy | null | undefined;
  closeSession?: ((sessionId: string) => void) | undefined;
  loginAudit?: LoginAuditRequest | undefined;
}
