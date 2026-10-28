import type { PrismaClient } from '@opensamguk/db';
import { z } from 'zod';
import { activeSanctionWhere } from '../auth/sanction';

const requestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  reason: z.string().trim().min(1).max(200),
  role: z.enum(['USER', 'ADMIN']),
});

export async function changeAdminRole(db: PrismaClient, input: z.input<typeof requestSchema>) {
  const request = requestSchema.parse(input);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; role: 'USER' | 'ADMIN' }>>`
      SELECT "id", "status", "role" FROM "User" WHERE "email" = ${request.email} FOR UPDATE
    `;
    const user = rows[0];
    if (!user || user.status !== 'ACTIVE') throw new Error('활성 대상 계정을 확인하세요.');
    if (
      request.role === 'ADMIN' &&
      (await tx.sanction.findFirst({
        where: { userId: user.id, ...activeSanctionWhere(Date.now()) },
        select: { id: true },
      }))
    )
      throw new Error('대상 계정의 유효한 제재를 먼저 해제하세요.');
    const changed = user.role !== request.role;
    if (changed) await tx.user.update({ where: { id: user.id }, data: { role: request.role } });
    const audit = await tx.auditLog.create({
      data: {
        actorKind: 'CLI',
        action: request.role === 'ADMIN' ? 'admin.grant' : 'admin.revoke',
        targetType: 'User',
        targetId: user.id,
        reason: request.reason,
        payload: { beforeRole: user.role, afterRole: request.role, changed },
      },
      select: { id: true },
    });
    return { userId: user.id, role: request.role, changed, auditId: audit.id.toString() };
  });
}
