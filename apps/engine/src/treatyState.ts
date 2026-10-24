import type { Prisma } from '@opensamguk/db';
import {
  TICKS_PER_MONTH,
  treatyClosures,
  validateTreatyState,
  validateNationTrustState,
  type DeepReadonly,
  type WorldState,
} from '@opensamguk/rules';

export async function loadNationTrust(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Pick<WorldState, 'nationTrust'>> {
  const rows = await tx.nationTrust.findMany({
    where: { worldId },
    orderBy: { nationId: 'asc' },
    select: { nationId: true, brokenTreaties: true, lastBrokenTick: true },
  });
  return rows.length ? { nationTrust: validateNationTrustState(rows) } : {};
}

export async function loadTreaties(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Pick<WorldState, 'treaties'>> {
  const rows = await tx.treaty.findMany({
    where: { worldId, status: { in: ['PROPOSED', 'ACTIVE'] } },
    orderBy: { id: 'asc' },
  });
  const treaties = rows.map((row) => {
    if (row.closedSequence !== null) throw new Error('열린 조약에 마감 기록이 있습니다.');
    if (row.status === 'PROPOSED' && (row.costFrom !== null || row.costTo !== null))
      throw new Error('아직 수락하지 않은 조약에 납부 기록이 있습니다.');
    if (row.status === 'ACTIVE' && ![row.costFrom, row.costTo].every(storedCost))
      throw new Error('수락한 조약의 납부 기록을 확인하세요.');
    return validateTreatyState({
      id: row.id,
      fromNationId: row.fromNationId,
      toNationId: row.toNationId,
      clauses: row.clauses,
      status: row.status,
      proposedTick: row.proposedTick,
      respondByTick: row.respondByTick,
      startTick: row.startTick,
      endTick: row.endTick,
    });
  });
  return treaties.length ? { treaties } : {};
}

function storedCost(value: number | null): boolean {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

// 호출자가 같은 펜싱 트랜잭션에서 settleTreaties를 마친 before·next를 넘긴다.
// 월간 sequence를 재사용하며 리스·월드 잠금·트랜잭션은 여기서 만들지 않는다.
export async function persistTreatyClosures(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: DeepReadonly<WorldState>,
  next: DeepReadonly<WorldState>,
  at: { tick: number; sequence: number },
): Promise<void> {
  if (
    !Number.isSafeInteger(at.tick) ||
    at.tick <= 0 ||
    at.tick > 2_147_483_647 - TICKS_PER_MONTH ||
    at.tick % TICKS_PER_MONTH !== 0 ||
    !Number.isSafeInteger(at.sequence) ||
    at.sequence < 1 ||
    at.sequence > 2_147_483_647
  )
    throw new Error('조약 마감의 월 경계와 순서를 확인하세요.');
  const originals = new Map(before.treaties?.map((entry) => [entry.id, entry]));
  for (const closure of treatyClosures(before, next)) {
    const original = originals.get(closure.id)!;
    const updated = await tx.treaty.updateMany({
      where: { worldId, id: closure.id, status: original.status, closedSequence: null },
      data: { status: closure.status, closedSequence: at.sequence },
    });
    if (updated.count !== 1) throw new Error('조약 마감 대상이 변경됐습니다.');
  }
}
