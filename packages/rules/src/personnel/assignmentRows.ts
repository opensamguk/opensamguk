import { z } from 'zod';
import type { WorldState } from '../model/world';

const integer = z.number().int().min(0).max(2_147_483_647);
const pendingRow = z.object({
  worldId: z.string(),
  status: z.literal('PENDING'),
  resolvedBy: z.null(),
  cancelReason: z.null(),
  resolvedTick: z.null(),
  targetGeneralId: integer.min(1),
  id: z.string().min(1),
  nationId: integer.min(1),
  issuerGeneralId: integer.min(1),
  cityKey: integer.min(1),
  createdTick: integer,
  expiresTick: integer,
});

// 저장소 행의 불필요한 날짜·메타데이터는 제외한다. API와 엔진이 같은 발령 제안을 판정한다.
export function pendingAssignmentsFromRows(
  rows: readonly unknown[],
  worldId: string,
): Pick<WorldState, 'assignmentOffers'> {
  const assignmentOffers: NonNullable<WorldState['assignmentOffers']> = {},
    ids = new Set<string>();
  for (const value of rows) {
    const row = pendingRow.parse(value);
    if (row.worldId !== worldId) throw Error('발령 제안의 월드가 다릅니다.');
    if (Object.hasOwn(assignmentOffers, row.targetGeneralId) || ids.has(row.id))
      throw Error('저장된 발령 대상 또는 제안 id가 중복됐습니다.');
    assignmentOffers[row.targetGeneralId] = {
      id: row.id,
      nationId: row.nationId,
      issuerGeneralId: row.issuerGeneralId,
      cityKey: row.cityKey,
      createdTick: row.createdTick,
      expiresTick: row.expiresTick,
    };
    ids.add(row.id);
  }
  return rows.length ? { assignmentOffers } : {};
}
