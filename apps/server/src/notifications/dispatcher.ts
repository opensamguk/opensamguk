import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { notificationPayloadSchema, type NotificationPayload } from '@opensamguk/shared/notifications';
import { hasGlobalSanction } from '../auth/sanction';
import { sendDiscordWebhook, type DiscordWebhookSendResult, type DiscordWebhookTransport } from './discordWebhook';

type Tx = Prisma.TransactionClient;
type Claim = {
  id: string;
  userId: string;
  claimId: string;
  targetId: string;
  generation: number;
  endpoint: string;
  payload: NotificationPayload;
  attempts: number;
};
type PublicClaim = Pick<Claim, 'id' | 'userId' | 'claimId' | 'targetId' | 'generation'>;
const discordMarkup = new Set(['`', '*', '_', '~', '|', '[', ']', '(', ')', '<', '>']);
function plainDiscordText(value: string) {
  // 이름과 설명의 링크·마크업을 막고 문장 끝 마침표는 유지한다.
  const text = value
    .replaceAll('\\', '＼')
    .replaceAll(':', '：')
    .replaceAll('/', '／')
    .replace(/([\p{L}\p{N}_-])\.(?=[\p{L}\p{N}_-])/gu, '$1．');
  return Array.from(text, (character) => (discordMarkup.has(character) ? '\\' + character : character)).join('');
}
export type DispatchOptions = {
  publicOrigin: string;
  transport?: DiscordWebhookTransport;
  shouldStop?: () => boolean;
  // 신뢰한 호출자의 정착/중단 검증 전용이다. HTTP·환경 입력으로 받지 않는다.
  afterClaim?: (claim: PublicClaim) => Promise<void>;
  beforeResult?: (claim: PublicClaim) => Promise<void>;
  onSummary?: (summary: { unknown: number }) => void;
};
async function clock(tx: Pick<Tx, '$queryRaw'>) {
  const [value] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!value) throw Error('알림 처리 시각을 확인하세요.');
  return value.now;
}
async function gate(tx: Tx) {
  const [value] = await tx.$queryRaw<Array<{ blockedUntil: Date | null }>>`
    SELECT "blockedUntil" FROM "NotificationDispatchGate" WHERE id='discord' FOR UPDATE`;
  if (!value) throw Error('알림 발송 기한을 확인하세요.');
  return value;
}
async function lockUser(tx: Tx, userId: string) {
  const [user] = await tx.$queryRaw<Array<{ status: string; notificationGeneration: number }>>`
    SELECT status,"notificationGeneration" FROM "User" WHERE id=${userId} FOR SHARE`;
  return user;
}
async function claimOne(db: PrismaClient, id: string, userId: string): Promise<Claim | 'BLOCKED' | null> {
  return db.$transaction(async (tx) => {
    const currentGate = await gate(tx);
    const now = await clock(tx);
    if (currentGate.blockedUntil && currentGate.blockedUntil > now) return 'BLOCKED';
    const user = await lockUser(tx, userId);
    const row = await tx.notificationOutbox.findUnique({ where: { id } });
    if (!row || row.userId !== userId || !['PENDING', 'RETRY'].includes(row.status) || row.nextAttemptAt > now)
      return null;
    const available = { id, status: { in: ['PENDING', 'RETRY'] as Array<'PENDING' | 'RETRY'> } };
    if (row.attempts >= 4) {
      await tx.notificationOutbox.updateMany({
        where: available,
        data: { status: 'GAVE_UP', resultCode: 'ATTEMPTS_EXHAUSTED' },
      });
      return null;
    }
    if (!user || user.status !== 'ACTIVE' || (await hasGlobalSanction(tx, userId, (await clock(tx)).getTime()))) {
      await tx.notificationOutbox.updateMany({
        where: available,
        data: { status: 'GAVE_UP', resultCode: 'ACCOUNT_INACTIVE' },
      });
      return null;
    }
    const target = await tx.notificationTarget.findUnique({ where: { userId } });
    if (!target || !target.events.includes(row.event)) {
      await tx.notificationOutbox.deleteMany({ where: available });
      return null;
    }
    const payload = notificationPayloadSchema.safeParse(row.payload);
    if (target.status !== 'ACTIVE' || !payload.success || payload.data.worldId !== row.worldId) {
      await tx.notificationOutbox.updateMany({
        where: available,
        data: { status: 'GAVE_UP', resultCode: target.status !== 'ACTIVE' ? 'TARGET_DISABLED' : 'PAYLOAD_INVALID' },
      });
      return null;
    }
    const claimId = randomUUID();
    const claimedAt = await clock(tx);
    const updated = await tx.notificationOutbox.updateMany({
      where: { ...available, nextAttemptAt: { lte: now }, attempts: { lt: 4 } },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        claimId,
        claimedAt,
        targetId: target.id,
        generation: user.notificationGeneration,
        resultCode: null,
      },
    });
    if (updated.count !== 1) return null;
    return {
      id,
      userId,
      claimId,
      targetId: target.id,
      generation: user.notificationGeneration,
      endpoint: target.endpoint,
      payload: payload.data,
      attempts: row.attempts + 1,
    };
  });
}
const retryDelay = (attempts: number) => [60_000, 300_000, 900_000][Math.min(attempts - 1, 2)]!;
async function saveResult(db: PrismaClient, claim: Claim, result: DiscordWebhookSendResult) {
  return db.$transaction(async (tx) => {
    const currentGate = await gate(tx);
    const now = await clock(tx);
    const limited = result.kind === 'HTTP_OBSERVED' && result.status === 429;
    if (limited) {
      const until = new Date(
        now.getTime() +
          (result.retryAfterSeconds === null ? retryDelay(claim.attempts) : result.retryAfterSeconds * 1000),
      );
      if (!currentGate.blockedUntil || currentGate.blockedUntil < until)
        await tx.notificationDispatchGate.update({ where: { id: 'discord' }, data: { blockedUntil: until } });
    }
    await lockUser(tx, claim.userId);
    const status =
      result.kind === 'UNKNOWN'
        ? 'UNKNOWN'
        : result.kind === 'NOT_SENT'
          ? 'GAVE_UP'
          : result.category === 'STATUS_2XX'
            ? 'SENT'
            : result.category === 'STATUS_5XX'
              ? 'UNKNOWN'
              : limited && claim.attempts < 4
                ? 'RETRY'
                : 'GAVE_UP';
    const code = result.kind === 'HTTP_OBSERVED' ? result.category : result.code;
    const nextAttemptAt = limited
      ? new Date(now.getTime() + Math.max(retryDelay(claim.attempts), (result.retryAfterSeconds ?? 0) * 1000))
      : undefined;
    const updated = await tx.notificationOutbox.updateMany({
      where: { id: claim.id, claimId: claim.claimId, status: 'SENDING' },
      data: { status, resultCode: code, ...(nextAttemptAt ? { nextAttemptAt } : {}) },
    });
    if (updated.count === 1 && result.kind === 'HTTP_OBSERVED' && result.category === 'STATUS_401_404')
      await tx.notificationTarget.updateMany({
        where: { id: claim.targetId, userId: claim.userId, status: 'ACTIVE' },
        data: { status: 'DISABLED', disabledReason: 'DISCORD_GONE' },
      });
    return updated.count;
  });
}

export async function dispatchNotificationBatch(db: PrismaClient, options: DispatchOptions) {
  const origin = new URL(options.publicOrigin);
  if (origin.origin !== options.publicOrigin || !['http:', 'https:'].includes(origin.protocol))
    throw Error('알림 화면 출처를 확인하세요.');
  const now = await clock(db);
  const reaped = await db.notificationOutbox.updateMany({
    where: { status: 'SENDING', claimedAt: { lte: new Date(now.getTime() - 60_000) } },
    data: { status: 'UNKNOWN', resultCode: 'STALE_CLAIM' },
  });
  const rows = await db.notificationOutbox.findMany({
    where: { status: { in: ['PENDING', 'RETRY'] }, nextAttemptAt: { lte: now } },
    select: { id: true, userId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 20,
  });
  let unknown = reaped.count;
  let claimed = 0,
    blocked = false;
  for (const row of rows) {
    if (options.shouldStop?.()) break;
    const claim = await claimOne(db, row.id, row.userId);
    if (claim === 'BLOCKED') {
      blocked = true;
      break;
    }
    if (!claim) continue;
    claimed++;
    const identity = {
      id: claim.id,
      userId: claim.userId,
      claimId: claim.claimId,
      targetId: claim.targetId,
      generation: claim.generation,
    };
    await options.afterClaim?.(identity);
    const payload = claim.payload;
    const result = await sendDiscordWebhook(
      {
        url: claim.endpoint,
        content: `[오픈삼국] ${plainDiscordText(payload.worldName)} ${payload.year}년 ${payload.month}월\n${plainDiscordText(payload.text)}\n${origin.origin}/w/${payload.worldId}`,
      },
      options.transport ? { transport: options.transport } : undefined,
    );
    await options.beforeResult?.(identity);
    const recorded = await saveResult(db, claim, result);
    if (
      recorded === 1 &&
      (result.kind === 'UNKNOWN' || (result.kind === 'HTTP_OBSERVED' && result.category === 'STATUS_5XX'))
    )
      unknown++;
    if (result.kind === 'HTTP_OBSERVED' && result.status === 429) {
      blocked = true;
      break;
    }
  }
  if (unknown) options.onSummary?.({ unknown });
  return { claimed, more: rows.length === 20 && !blocked && !options.shouldStop?.() };
}

export function startNotificationDispatcher(db: PrismaClient, options: DispatchOptions, failed: () => void) {
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  const run = async () => {
    try {
      while (!stopping) {
        const result = await dispatchNotificationBatch(db, { ...options, shouldStop: () => stopping });
        if (!result.more) break;
      }
    } catch {
      failed();
    } finally {
      if (!stopping)
        timer = setTimeout(() => {
          active = run();
        }, 10_000);
    }
  };
  active = run();
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      await active;
    },
  };
}
