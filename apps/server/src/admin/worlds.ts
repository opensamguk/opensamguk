import { TRPCError } from '@trpc/server';
import type { Context } from '../context';
import { requireCurrentAdmin } from './access';

export async function listAdminWorlds(ctx: Context) {
  try {
    return await ctx.db.$transaction(
      async (tx) => {
        await requireCurrentAdmin(tx, ctx, false);
        const worlds = await tx.world.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            name: true,
            status: true,
            clockRevision: true,
            scenarioKey: true,
            presetKey: true,
            turnTermMinutes: true,
            _count: { select: { generals: { where: { userId: { not: null } } } } },
            engineHeartbeat: { select: { at: true, lastTick: true, lagMs: true, lastError: true } },
          },
        });
        return worlds.map(({ _count, engineHeartbeat, ...world }) => ({
          ...world,
          humanGenerals: _count.generals,
          heartbeat: engineHeartbeat
            ? {
                at: engineHeartbeat.at.toISOString(),
                lastTick: engineHeartbeat.lastTick,
                lagMs: engineHeartbeat.lagMs,
                lastError: engineHeartbeat.lastError === null ? null : '엔진 오류가 기록되어 있습니다.',
              }
            : null,
        }));
      },
      { isolationLevel: 'RepeatableRead' },
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '월드 목록을 확인하지 못했습니다.' });
  }
}
