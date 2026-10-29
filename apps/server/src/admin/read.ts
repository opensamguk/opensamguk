import { TRPCError } from '@trpc/server';
import type { Prisma, PrismaClient } from '@opensamguk/db';
import { z } from 'zod';
import { activeSanctionWhere } from '../auth/sanction';

const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) =>
      [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    );
export const searchUsersInput = z.strictObject({
  query: z.union([text(3, 254), z.strictObject({ worldId: z.uuid(), generalName: text(1, 30) })]),
});
export const getUserInput = z.strictObject({ userId: z.uuid() });
export const auditListInput = z
  .strictObject({
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    action: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9.]*$/)
      .optional(),
    actorUserId: z.uuid().optional(),
    targetId: text(1, 200).optional(),
    worldId: z.uuid().optional(),
  })
  .refine((input) => !input.from || !input.to || Date.parse(input.from) <= Date.parse(input.to), {
    message: '기간 순서를 확인하세요.',
  });

async function readAsAdmin<T>(db: PrismaClient, actorId: string, read: (tx: Prisma.TransactionClient) => Promise<T>) {
  try {
    return await db.$transaction(
      async (tx) => {
        // 권한 회수와 개인정보 조회가 엇갈려도 기록 없이 결과를 내보내지 않는다.
        const [actor] = await tx.$queryRaw<Array<{ status: string; role: string }>>`
        SELECT status,role FROM "User" WHERE id=${actorId} FOR SHARE
      `;
        if (!actor || actor.status !== 'ACTIVE')
          throw new TRPCError({ code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' });
        if (actor.role !== 'ADMIN') throw new TRPCError({ code: 'FORBIDDEN', message: '관리자 권한이 필요합니다.' });
        return read(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // DB 오류의 쿼리·검색어·이메일을 오류 응답이나 로그로 넘기지 않는다.
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '관리자 정보를 확인하지 못했습니다.' });
  }
}

export async function searchUsers(
  db: PrismaClient,
  actorId: string,
  input: z.infer<typeof searchUsersInput>,
  now: number,
) {
  return readAsAdmin(db, actorId, async (tx) => {
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : input.query;
    const queryKind =
      typeof query !== 'string' ? 'GENERAL_NAME' : z.uuid().safeParse(query).success ? 'USER_ID' : 'EMAIL_PREFIX';
    let ids: Array<{ id: string }>;
    if (typeof query !== 'string') {
      ids = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT u.id FROM "User" u
        WHERE EXISTS(SELECT 1 FROM "General" g WHERE g."userId"=u.id AND g."worldId"=${query.worldId} AND starts_with(g.name,${query.generalName}))
        ORDER BY u."createdAt" DESC,u.id DESC LIMIT 50
      `;
    } else if (queryKind === 'USER_ID') ids = [{ id: query }];
    else {
      // LIKE의 %·_·역슬래시도 검색어 그대로 취급한다.
      ids = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "User" WHERE starts_with(email,${query}) ORDER BY "createdAt" DESC,id DESC LIMIT 50
      `;
    }
    const users = await tx.user.findMany({
      where: { id: { in: ids.map((user) => user.id) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        email: true,
        status: true,
        role: true,
        createdAt: true,
        _count: { select: { sanctions: { where: activeSanctionWhere(now) } } },
      },
    });
    const result = users.map((user) => ({
      userId: user.id,
      email: user.email,
      status: user.status,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      activeSanctions: user._count.sanctions,
    }));
    await tx.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: actorId,
        action: 'user.search',
        targetType: 'User',
        worldId: typeof query === 'string' ? null : query.worldId,
        payload: { queryKind, resultCount: result.length },
      },
      select: { id: true },
    });
    return result;
  });
}

export async function getUser(db: PrismaClient, actorId: string, input: z.infer<typeof getUserInput>, now: number) {
  const result = await readAsAdmin(db, actorId, async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        status: true,
        role: true,
        createdAt: true,
        emailVerifiedAt: true,
        _count: { select: { generals: true, sanctions: true } },
        generals: {
          take: 50,
          orderBy: [{ world: { createdAt: 'desc' } }, { worldId: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            name: true,
            nationId: true,
            worldId: true,
            world: { select: { name: true, status: true } },
          },
        },
        sanctions: {
          take: 50,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            worldId: true,
            world: { select: { name: true } },
            reason: true,
            createdAt: true,
            expiresAt: true,
            liftedAt: true,
          },
        },
      },
    });
    await tx.auditLog.create({
      data: {
        actorKind: 'ADMIN',
        actorUserId: actorId,
        action: 'user.view',
        targetType: 'User',
        targetId: input.userId,
        payload: {
          resultCount: user ? 1 : 0,
          generalsDisplayed: user?.generals.length ?? 0,
          sanctionsDisplayed: user?.sanctions.length ?? 0,
        },
      },
      select: { id: true },
    });
    if (!user) return null;
    return {
      userId: user.id,
      email: user.email,
      status: user.status,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      emailVerified: user.emailVerifiedAt !== null,
      generalCount: user._count.generals,
      sanctionCount: user._count.sanctions,
      generals: user.generals.map((general) => ({
        generalId: general.id,
        name: general.name,
        nationId: general.nationId,
        worldId: general.worldId,
        worldName: general.world.name,
        worldStatus: general.world.status,
      })),
      sanctions: user.sanctions.map((sanction) => ({
        sanctionId: sanction.id,
        worldId: sanction.worldId,
        worldName: sanction.world?.name ?? null,
        reason: sanction.reason,
        createdAt: sanction.createdAt.toISOString(),
        expiresAt: sanction.expiresAt?.toISOString() ?? null,
        liftedAt: sanction.liftedAt?.toISOString() ?? null,
        active: sanction.liftedAt === null && (sanction.expiresAt === null || sanction.expiresAt.getTime() > now),
      })),
    };
  });
  // 빈 조회도 감사가 commit된 뒤 응답한다. 트랜잭션 안에서 예외를 던지면 감사가 사라진다.
  if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: '계정을 찾을 수 없습니다.' });
  return result;
}

export async function listAudit(db: PrismaClient, actorId: string, input: z.infer<typeof auditListInput>) {
  return readAsAdmin(db, actorId, async (tx) => {
    const items = await tx.auditLog.findMany({
      where: {
        ...(input.cursor ? { id: { lt: BigInt(input.cursor) } } : {}),
        ...(input.from || input.to
          ? {
              at: {
                ...(input.from ? { gte: new Date(input.from) } : {}),
                ...(input.to ? { lte: new Date(input.to) } : {}),
              },
            }
          : {}),
        ...(input.action ? { action: { startsWith: input.action } } : {}),
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
        ...(input.targetId ? { targetId: input.targetId } : {}),
        ...(input.worldId ? { worldId: input.worldId } : {}),
      },
      orderBy: { id: 'desc' },
      take: 51,
      select: {
        id: true,
        at: true,
        actorKind: true,
        actorUserId: true,
        action: true,
        targetType: true,
        targetId: true,
        worldId: true,
        reason: true,
        payload: true,
        inputEventId: true,
      },
    });
    const page = items.slice(0, 50);
    return {
      items: page.map((item) => ({
        ...item,
        id: item.id.toString(),
        at: item.at.toISOString(),
        inputEventId: item.inputEventId?.toString() ?? null,
      })),
      next: items.length > 50 ? page.at(-1)!.id.toString() : null,
    };
  });
}
