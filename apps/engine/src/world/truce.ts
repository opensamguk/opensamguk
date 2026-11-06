import { effectiveWorldOptions, parsePreset, truceWindow, type Clock } from '@opensamguk/rules';

type ClockWorld = Omit<Clock, 'clockAnchorAt' | 'truce'> & {
  clockAnchorAt: Date | null;
  preset: unknown;
  runtimeOptions: unknown;
};
export function worldClock(world: ClockWorld): Clock {
  return {
    status: world.status,
    ...(world.clockMode === undefined ? {} : { clockMode: world.clockMode }),
    clockTick: world.clockTick,
    clockAnchorAt: world.clockAnchorAt?.getTime() ?? null,
    turnTermMinutes: world.turnTermMinutes,
    truce: effectiveWorldOptions(world.preset === null ? null : parsePreset(world.preset), world.runtimeOptions).truce,
  };
}
export function clockTruceStatus(clock: Clock, now: number) {
  if (clock.truce == null) return null;
  const window = truceWindow(now, clock.truce);
  return {
    ...clock.truce,
    active: window.active,
    endsAt: window.endsAt === null ? null : new Date(window.endsAt).toISOString(),
    nextStartsAt: new Date(window.nextStartsAt).toISOString(),
    nextEndsAt: new Date(window.nextEndsAt).toISOString(),
  };
}
