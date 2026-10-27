import type { Prisma } from '@opensamguk/db';

type Anchors = Readonly<Record<number, number>>;
const maxInteger = 2_147_483_647;

function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maxInteger;
}

function anchorMap(value: Anchors): Map<number, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('물리 거주 앵커 목록을 확인하세요.');
  const result = new Map<number, number>();
  for (const key of Reflect.ownKeys(value)) {
    const id = typeof key === 'string' ? Number(key) : NaN;
    if (!integer(id, 1) || String(id) !== key || !integer(value[id], 0))
      throw new Error('물리 거주 앵커의 장수 번호와 tick을 확인하세요.');
    result.set(id, value[id]!);
  }
  return result;
}

function readRows(tx: Prisma.TransactionClient, worldId: string) {
  return tx.general.findMany({
    where: { worldId },
    select: { id: true, userId: true, residenceTick: true },
    orderBy: { id: 'asc' },
  });
}

export async function assertNoResidenceAnchors(tx: Prisma.TransactionClient, worldId: string): Promise<void> {
  const row = await tx.general.findFirst({
    where: { worldId, residenceTick: { not: null } },
    select: { id: true },
  });
  if (row) throw new Error('인사 기능을 끈 월드에 물리 거주 앵커가 있습니다.');
}

// 같은 트랜잭션에서 해당 월드의 장수 전체를 읽은 호출자가 재조회 없이 같은 경계를 검사한다.
export function assertNoResidenceAnchorsInRows(rows: readonly { residenceTick: number | null }[]): void {
  if (rows.some((row) => row.residenceTick !== null))
    throw new Error('인사 기능을 끈 월드에 물리 거주 앵커가 있습니다.');
}

export async function loadResidenceAnchors(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Record<number, number>> {
  const result: Record<number, number> = {};
  for (const row of await readRows(tx, worldId)) {
    if (row.userId === null) {
      if (row.residenceTick !== null) throw new Error('NPC 장수에 물리 거주 앵커가 있습니다.');
      continue;
    }
    if (!integer(row.residenceTick, 0)) throw new Error('사람 장수의 물리 거주 앵커가 없습니다.');
    result[row.id] = row.residenceTick;
  }
  return result;
}

// 호출자는 World 잠금 아래 최종 장수 행을 쓴 뒤 같은 트랜잭션에서 호출한다.
// 새 사람 행은 residenceTick null로 만들고 여기서 실제 생성 tick을 확정한다.
export async function persistResidenceAnchors(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: Anchors,
  after: Anchors,
): Promise<void> {
  const previous = anchorMap(before);
  const next = anchorMap(after);
  const rows = await readRows(tx, worldId);
  const people = new Set(rows.filter((row) => row.userId !== null).map((row) => row.id));
  if (next.size !== people.size || [...next.keys()].some((id) => !people.has(id)))
    throw new Error('최종 사람 장수와 물리 거주 앵커가 다릅니다.');
  const changes = rows.flatMap((row) => {
    const expected = previous.get(row.id) ?? null;
    if (row.residenceTick !== expected) throw new Error('저장된 물리 거주 앵커와 시작값이 다릅니다.');
    const tick = row.userId === null ? null : next.get(row.id)!;
    return tick === expected ? [] : [{ id: row.id, userId: row.userId, expected, tick }];
  });
  for (const change of changes) {
    const result = await tx.general.updateMany({
      where: { worldId, id: change.id, userId: change.userId, residenceTick: change.expected },
      data: { residenceTick: change.tick },
    });
    if (result.count !== 1) throw new Error('물리 거주 앵커가 한 행에 저장되지 않았습니다.');
  }
}
