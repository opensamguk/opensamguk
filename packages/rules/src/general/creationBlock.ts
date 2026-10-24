import type { ClockStatus } from '../clock/clock';

export type CreationBlock =
  { code: 'ALREADY_EXISTS'; reason: null } | { code: 'WORLD_CLOSED' | 'PENDING'; reason: string };

export function creationBlock(input: {
  status: ClockStatus;
  hasGeneral: boolean;
  hasPending: boolean;
}): CreationBlock | null {
  if (input.hasGeneral) return { code: 'ALREADY_EXISTS', reason: null };
  if (input.status === 'PAUSED') return { code: 'WORLD_CLOSED', reason: '멈춘 월드입니다' };
  if (input.status === 'ENDED') return { code: 'WORLD_CLOSED', reason: '끝난 월드입니다' };
  if (input.status === 'PREOPEN') return { code: 'WORLD_CLOSED', reason: '아직 열리지 않은 월드입니다' };
  if (input.hasPending) return { code: 'PENDING', reason: '장수를 만드는 중입니다' };
  return null;
}
