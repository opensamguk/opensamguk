import type { Prisma } from '@opensamguk/db';
import {
  projectTreatyRows,
  selectWorldCapabilities,
  validateClosedTreatyRow,
  type ClosedTreatyRow,
  type FirstTreatyClause,
  type TreatyState,
} from '@opensamguk/rules';
import { TRPCError } from '@trpc/server';

type StoredWorld = Prisma.WorldGetPayload<Record<string, never>>;
type StoredTreaty = Prisma.TreatyGetPayload<Record<string, never>>;
export type CheckedTreatyRow =
  (TreatyState & { costFrom: number | null; costTo: number | null; closedSequence: null }) | ClosedTreatyRow;
export type TreatyDetail = {
  id: string;
  fromNationId: number;
  toNationId: number;
  incoming: boolean;
  clauses: FirstTreatyClause[];
  status: 'PROPOSED' | 'ACTIVE' | 'REJECTED' | 'EXPIRED' | 'ENDED';
  proposedTick: number;
  respondByTick: number | null;
  startTick: number | null;
  endTick: number | null;
  cost: { from: number; to: number } | null;
};

function invalid(): never {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: '저장된 조약을 확인하지 못했습니다.' });
}

export function requireTreatyWorld(world: StoredWorld): void {
  let selected: ReturnType<typeof selectWorldCapabilities>;
  try {
    selected = selectWorldCapabilities(world);
  } catch {
    invalid();
  }
  if (selected.kind !== 'caps')
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: '조약 기능을 쓰지 않는 월드입니다.' });
}

// 호출자는 같은 트랜잭션에서 실제 World를 선택하고 requireTreatyWorld를 먼저 부른다.
export function checkTreatyRow(world: StoredWorld, row: StoredTreaty): CheckedTreatyRow {
  try {
    const { worldId, ...storage } = row;
    if (
      worldId !== world.id ||
      !Number.isInteger(world.actionSequence) ||
      world.actionSequence < 0 ||
      world.actionSequence > 2_147_483_647
    )
      invalid();
    let checked: CheckedTreatyRow;
    if (storage.status === 'PROPOSED' || storage.status === 'ACTIVE') {
      const treaties = projectTreatyRows([storage]);
      if (treaties?.length !== 1) invalid();
      checked = { ...treaties[0]!, costFrom: storage.costFrom, costTo: storage.costTo, closedSequence: null };
    } else checked = validateClosedTreatyRow(storage);
    if (
      checked.id > world.actionSequence ||
      (checked.closedSequence !== null && checked.closedSequence > world.actionSequence)
    )
      invalid();
    return checked;
  } catch {
    invalid();
  }
}

export function toTreatyDetail(row: CheckedTreatyRow, viewerNationId: number | null): TreatyDetail | null {
  if (viewerNationId === null || (viewerNationId !== row.fromNationId && viewerNationId !== row.toNationId))
    return null;
  let cost: TreatyDetail['cost'] = null;
  if (row.status === 'ACTIVE' || row.status === 'ENDED') {
    if (row.costFrom === null || row.costTo === null) invalid();
    cost = { from: row.costFrom, to: row.costTo };
  }
  return {
    id: String(row.id),
    fromNationId: row.fromNationId,
    toNationId: row.toNationId,
    incoming: viewerNationId === row.toNationId,
    clauses: structuredClone(row.clauses),
    status: row.status,
    proposedTick: row.proposedTick,
    respondByTick: row.status === 'PROPOSED' ? row.respondByTick : null,
    startTick: row.startTick,
    endTick: row.endTick,
    cost,
  };
}
