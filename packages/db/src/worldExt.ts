import { hashState } from '@opensamguk/shared/node';
import type { Prisma } from './generated/prisma/client';
import { assertStorableJson } from './storableJson';

function assertSlices(value: unknown): asserts value is Record<string, unknown> | undefined {
  if (value === undefined) return;
  assertStorableJson(value, 'ext');
  if (value === null || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length === 0)
    throw new Error('확장 상태의 조각 목록을 확인하세요.');
}

export async function readWorldExtRows(
  tx: Prisma.TransactionClient,
  worldId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await tx.$queryRaw<{ key: string; value: unknown }[]>`
    SELECT "key", "value" FROM "WorldExtSlice" WHERE "worldId" = ${worldId} ORDER BY "key"
  `;
  if (rows.length === 0) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const row of rows) {
    if (Object.hasOwn(result, row.key)) throw new Error('확장 상태의 조각 목록을 확인하세요.');
    Object.defineProperty(result, row.key, { value: row.value, enumerable: true });
  }
  assertSlices(result);
  return result;
}

// 호출자가 턴·월간 저장과 같은 트랜잭션을 넘긴다. 생성·삭제는 이 함수의 몫이 아니다.
export async function writeWorldExtChanges(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: unknown,
  next: unknown,
): Promise<void> {
  assertSlices(before);
  assertSlices(next);
  const keys = Object.keys(before ?? {}).sort();
  const nextKeys = Object.keys(next ?? {}).sort();
  if (keys.length !== nextKeys.length || keys.some((key, index) => key !== nextKeys[index]))
    throw new Error('확장 상태의 조각 목록을 확인하세요.');
  for (const key of keys) {
    if (hashState(before![key]) === hashState(next![key])) continue;
    const count = await tx.$executeRaw`
      UPDATE "WorldExtSlice" SET "value" = ${JSON.stringify(next![key])}::jsonb
      WHERE "worldId" = ${worldId} AND "key" = ${key}
    `;
    if (count !== 1) throw new Error('저장된 확장 상태의 조각을 확인하세요.');
  }
}
