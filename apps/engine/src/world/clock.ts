import type { PrismaClient } from '@opensamguk/db';
import { checkpointClock, pauseClock, resumeClock, startClock, toGameDate, type Clock } from '@opensamguk/rules';

export type ClockAction = 'start' | 'pause' | 'resume' | 'status';
export async function controlClock(db: PrismaClient, worldId: string, action: ClockAction, now = Date.now()) {
  return db.$transaction(async (tx) => {
    const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
    const clock: Clock = { status: world.status, clockTick: world.clockTick,
      clockAnchorAt: world.clockAnchorAt?.getTime() ?? null, turnTermMinutes: world.turnTermMinutes };
    const next = action === 'start' ? startClock(clock, now) : action === 'pause' ? pauseClock(clock, now)
      : action === 'resume' ? resumeClock(clock, now) : checkpointClock(clock, now);
    if (action !== 'status' || world.status === 'RUNNING') {
      const saved = await tx.world.updateMany({ where: { id: worldId, clockRevision: world.clockRevision }, data: {
        status: next.status, clockTick: next.clockTick,
        clockAnchorAt: next.clockAnchorAt === null ? null : new Date(next.clockAnchorAt),
        clockRevision: { increment: 1 }, ...(action === 'start' ? { startedAt: new Date(now) } : {}),
      } });
      if (saved.count !== 1) throw new Error('다른 명령이 먼저 시계를 바꿨습니다. 최신 상태를 확인하세요.');
    }
    return { worldId, status: next.status, tick: next.clockTick, ...toGameDate(world.startYear, next.clockTick),
      turnTermMinutes: world.turnTermMinutes, seed: world.seed };
  });
}
