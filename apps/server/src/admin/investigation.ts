import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { Context } from '../context';
import { databaseTime } from '../messaging';
import { requireCurrentAdmin } from './access';

export const investigateSharedInput = z.strictObject({
  worldId: z.uuid(),
  days: z.number().int().min(1).max(90).default(7),
});

type SharedRecord = {
  kind: 'IP' | 'DEVICE';
  hashKeyVersion: number;
  hash: string;
  userId: string;
  generalId: number;
  generalName: string;
  logins: bigint;
  lastAt: Date;
};
type SharedGroup = {
  kind: 'IP' | 'DEVICE';
  label: string;
  users: Array<{ userId: string; generalId: number; generalName: string; logins: number; lastAt: string }>;
};

export async function investigateShared(ctx: Context, input: z.infer<typeof investigateSharedInput>) {
  try {
    return await ctx.db.$transaction(
      async (tx) => {
        const actorId = await requireCurrentAdmin(tx, ctx, false);
        const world = await tx.world.findUnique({ where: { id: input.worldId }, select: { id: true } });
        if (!world) throw new TRPCError({ code: 'NOT_FOUND', message: '월드를 찾을 수 없습니다.' });
        const now = await databaseTime(tx);
        const from = new Date(now.getTime() - input.days * 86_400_000);
        // 같은 월드 참가자, 기간, 키 버전과 전체 해시를 먼저 고정한다.
        // 다른 버전이나 앞 8자만 같은 해시를 한 묶음으로 합치지 않는다.
        const rows = await tx.$queryRaw<SharedRecord[]>`
        WITH records AS (
          SELECT r."hashKeyVersion",r."ipHash",r."deviceHash",r.at,r."userId",
                 g.id AS "generalId",g.name AS "generalName"
          FROM "LoginRecord" r
          JOIN "General" g ON g."userId"=r."userId" AND g."worldId"=${input.worldId}
          WHERE r.at>=${from} AND r.at<=${now}
        ), observed AS (
          SELECT 'IP'::text AS kind,"hashKeyVersion","ipHash" AS hash,"userId","generalId","generalName",at
          FROM records
          UNION ALL
          SELECT 'DEVICE'::text AS kind,"hashKeyVersion","deviceHash" AS hash,"userId","generalId","generalName",at
          FROM records WHERE "deviceHash" IS NOT NULL
        ), per_user AS (
          SELECT kind,"hashKeyVersion",hash,"userId","generalId","generalName",
                 count(*) AS logins,max(at) AS "lastAt"
          FROM observed GROUP BY kind,"hashKeyVersion",hash,"userId","generalId","generalName"
        ), shared AS (
          SELECT kind,"hashKeyVersion",hash FROM per_user
          GROUP BY kind,"hashKeyVersion",hash HAVING count(DISTINCT "userId")>=2
        )
        SELECT p.* FROM per_user p
        JOIN shared s ON p.kind=s.kind AND p."hashKeyVersion"=s."hashKeyVersion" AND p.hash=s.hash
        ORDER BY CASE p.kind WHEN 'IP' THEN 0 ELSE 1 END,p."hashKeyVersion",p.hash,p."userId"`;
        const result: SharedGroup[] = [];
        let previous: string | undefined;
        for (const row of rows) {
          const key = row.kind + ':' + row.hashKeyVersion + ':' + row.hash;
          if (key !== previous) {
            result.push({ kind: row.kind, label: row.hash.slice(0, 8), users: [] });
            previous = key;
          }
          const count = Number(row.logins);
          if (!Number.isSafeInteger(count) || count < 1) throw new Error('조사 기록 횟수를 확인하세요.');
          result[result.length - 1]!.users.push({
            userId: row.userId,
            generalId: row.generalId,
            generalName: row.generalName,
            logins: count,
            lastAt: row.lastAt.toISOString(),
          });
        }
        await tx.auditLog.create({
          data: {
            actorKind: 'ADMIN',
            actorUserId: actorId,
            action: 'investigate.shared.view',
            targetType: 'World',
            worldId: input.worldId,
            payload: { days: input.days, groupCount: result.length },
          },
          select: { id: true },
        });
        return result;
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // PostgreSQL의 쿼리·매개변수·원본 식별자를 응답이나 로그로 전달하지 않는다.
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '조사 자료를 확인하지 못했습니다.' });
  }
}
