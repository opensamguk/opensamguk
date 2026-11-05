import type { PrismaClient } from '@opensamguk/db';
import { z } from 'zod';
import { activeSanctionWhere } from '../auth/sanction';
import { databaseTime } from '../messaging';

const requestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  reason: z.string().trim().min(1).max(200),
  grant: z.boolean(),
});

export async function changeResourceEditorPermission(db: PrismaClient, input: z.input<typeof requestSchema>) {
  const request = requestSchema.parse(input);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; role: string }>>`
      SELECT id, status, role FROM "User" WHERE email=${request.email} FOR UPDATE
    `;
    const user = rows[0];
    if (!user) throw new Error('대상 계정을 확인하세요.');
    if (request.grant) {
      if (user.status !== 'ACTIVE' || user.role !== 'ADMIN') throw new Error('활성 관리자 계정만 지정하세요.');
      const now = await databaseTime(tx);
      if (await tx.sanction.findFirst({ where: { userId: user.id, ...activeSanctionWhere(now.getTime()) } }))
        throw new Error('대상 계정의 유효한 제재를 먼저 해제하세요.');
    }
    const before = (await tx.resourceEditorGrant.findUnique({ where: { userId: user.id } })) !== null;
    const changed = before !== request.grant;
    if (changed) {
      if (request.grant) await tx.resourceEditorGrant.create({ data: { userId: user.id } });
      else await tx.resourceEditorGrant.delete({ where: { userId: user.id } });
    }
    const audit = await tx.auditLog.create({
      data: {
        actorKind: 'CLI',
        action: request.grant ? 'resource-editor.grant' : 'resource-editor.revoke',
        targetType: 'User',
        targetId: user.id,
        reason: request.reason,
        payload: { before, after: request.grant, changed },
      },
      select: { id: true },
    });
    return { userId: user.id, resourceEditor: request.grant, changed, auditId: audit.id.toString() };
  });
}
