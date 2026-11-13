import type { ClockStatus } from '../clock/clock';

// core2026 df6c926, joinCreateGeneralService and selectPoolService.
export const HUMAN_GENERAL_LIMIT = 500;

export type CreationBlock =
  | { code: 'ALREADY_EXISTS'; reason: null }
  | { code: 'WORLD_CLOSED' | 'ENTRY_CLOSED' | 'WORLD_FULL' | 'PENDING'; reason: string };

export function creationBlock(input: {
  status: ClockStatus;
  hasGeneral: boolean;
  hasPending: boolean;
  entryOpen?: boolean;
  humanCount?: number;
}): CreationBlock | null {
  if (input.hasGeneral) return { code: 'ALREADY_EXISTS', reason: null };
  if (input.status === 'PAUSED') return { code: 'WORLD_CLOSED', reason: '멈춘 월드입니다' };
  if (input.status === 'ENDED') return { code: 'WORLD_CLOSED', reason: '끝난 월드입니다' };
  if (input.status === 'PREOPEN') return { code: 'WORLD_CLOSED', reason: '아직 열리지 않은 월드입니다' };
  if (input.entryOpen === false) return { code: 'ENTRY_CLOSED', reason: '지금은 새 장수를 받지 않습니다' };
  if (input.hasPending) return { code: 'PENDING', reason: '장수를 만드는 중입니다' };
  if ((input.humanCount ?? 0) >= HUMAN_GENERAL_LIMIT)
    return { code: 'WORLD_FULL', reason: '이 판의 장수 정원에 닿았습니다.' };
  return null;
}
