import type { DeepReadonly } from '../model/world';
import { TICKS_PER_MONTH } from '../clock/constants';
import { expireAssignments } from './assignments';
import type { OfficeRevisions, OfficeView } from './offices';
import type { PersonnelRawStep } from './step';

export function expirePersonnelMonth(
  settled: OfficeView,
  startOffices: DeepReadonly<OfficeRevisions>,
  tick: number,
): PersonnelRawStep {
  if (!Number.isSafeInteger(tick) || tick <= 0 || tick % TICKS_PER_MONTH !== 0)
    throw new RangeError('월 경계 tick이 필요합니다.');
  const expiry = expireAssignments(settled, tick);
  return { ...expiry, offices: structuredClone(startOffices) as OfficeRevisions };
}
