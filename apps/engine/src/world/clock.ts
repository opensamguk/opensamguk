import type { PrismaClient } from '@opensamguk/db';
import { checkpointClock, pauseClock, resumeClock, startClock, toGameDate, type Clock } from '@opensamguk/rules';
import { databaseNow } from '../lease';

export type ClockAction = 'start' | 'pause' | 'resume' | 'status' | 'accelerate' | 'realtime';
export async function controlClock(db: PrismaClient, worldId: string, action: ClockAction, injectedNow?: number) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "World" WHERE id = ${worldId} FOR UPDATE`;
    // 기다리는 동안 엔진이 저장한 시계와 잠금 획득 뒤의 DB 시각을 사용한다.
    const now = injectedNow ?? (await databaseNow(tx)).getTime();
    const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
    const clock: Clock = {
      status: world.status,
      clockMode: world.clockMode,
      clockTick: world.clockTick,
      clockAnchorAt: world.clockAnchorAt?.getTime() ?? null,
      turnTermMinutes: world.turnTermMinutes,
    };
    const mode = action === 'accelerate' ? 'ACCELERATED' : action === 'realtime' ? 'REALTIME' : world.clockMode;
    if (action === 'accelerate' || action === 'realtime') {
      if (!['RUNNING', 'PAUSED'].includes(world.status) || world.clockMode === mode)
        throw new Error('실행 중이거나 정지한 월드에서 다른 모드로만 바꿀 수 있습니다.');
    }
    const next =
      action === 'accelerate' || action === 'realtime'
        ? { ...checkpointClock(clock, now), clockMode: mode, clockAnchorAt: now }
        : action === 'start'
          ? startClock(clock, now)
          : action === 'pause'
            ? pauseClock(clock, now)
            : action === 'resume'
              ? resumeClock(clock, now)
              : checkpointClock(clock, now);
    if (action !== 'status' || world.status === 'RUNNING') {
      const saved = await tx.world.updateMany({
        where: { id: worldId, clockRevision: world.clockRevision },
        data: {
          status: next.status,
          clockMode: mode,
          clockTick: next.clockTick,
          clockAnchorAt: next.clockAnchorAt === null ? null : new Date(next.clockAnchorAt),
          clockRevision: { increment: 1 },
          ...(action === 'start' ? { startedAt: new Date(now) } : {}),
        },
      });
      if (saved.count !== 1) throw new Error('다른 명령이 먼저 시계를 바꿨습니다. 최신 상태를 확인하세요.');
    }
    const result = world.status === 'ENDED' ? await tx.worldResult.findUnique({ where: { worldId } }) : null;
    return {
      worldId,
      status: next.status,
      clockMode: mode,
      endYear: world.endYear,
      result,
      tick: next.clockTick,
      ...(result ? { year: result.endedYear, month: result.endedMonth } : toGameDate(world.startYear, next.clockTick)),
      turnTermMinutes: world.turnTermMinutes,
      seed: world.seed,
    };
  });
}
