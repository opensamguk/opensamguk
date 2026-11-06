import { TRPCError } from '@trpc/server';
import type { Prisma } from '@opensamguk/db';
import type { Context } from '../context';
import { requireCurrentAdmin } from '../admin/access';

export async function resourceEditorAccess(tx: Prisma.TransactionClient, ctx: Context, write: boolean) {
  const actorUserId = await requireCurrentAdmin(tx, ctx, write);
  const grants = await tx.$queryRaw<Array<{ userId: string }>>`
    SELECT "userId" FROM "ResourceEditorGrant" WHERE "userId"=${actorUserId} FOR SHARE
  `;
  return { actorUserId, resourceEditor: grants.length === 1 };
}

export async function requireResourceEditor(tx: Prisma.TransactionClient, ctx: Context, write: boolean) {
  const access = await resourceEditorAccess(tx, ctx, write);
  if (!access.resourceEditor) throw new TRPCError({ code: 'FORBIDDEN', message: '자원 편집 권한이 필요합니다.' });
  return access.actorUserId;
}
