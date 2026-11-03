import { HERITAGE_V1 } from './constants';

export interface HeritageCreationSpend {
  userId: string;
  key: string;
  delta: number;
  sequence: number;
}
export interface HeritageRefundEntry {
  userId: string;
  worldId: string;
  key: string;
  kind: 'CREATION_REFUND' | 'FORFEIT';
  delta: number;
  detail: { version: 1; sourceKey: string; reason: 'ADMIN_END' | 'ADMIN_RESET' };
}

export function creationRefunds(input: {
  worldId: string;
  reason: 'ADMIN_END' | 'ADMIN_RESET';
  spends: readonly HeritageCreationSpend[];
  existingKeys: ReadonlySet<string>;
  withdrawnUserIds: ReadonlySet<string>;
}): HeritageRefundEntry[] {
  const result: HeritageRefundEntry[] = [],
    seen = new Set<string>();
  const spends = [...input.spends].sort((a, b) =>
    a.userId === b.userId ? a.sequence - b.sequence : a.userId < b.userId ? -1 : 1,
  );
  for (const spend of spends) {
    if (
      !Number.isInteger(spend.sequence) ||
      spend.sequence < 1 ||
      spend.sequence > 2_147_483_647 ||
      spend.key !== `spend:${input.worldId}:${spend.sequence}` ||
      !Number.isInteger(spend.delta) ||
      spend.delta > -1 ||
      spend.delta < -HERITAGE_V1.perGeneral ||
      seen.has(spend.key)
    )
      throw new Error('유산 사용 원장을 확인하세요.');
    seen.add(spend.key);
    const key = `refund:${input.worldId}:${spend.sequence}`,
      forfeitKey = `forfeit:${key}`;
    if (input.existingKeys.has(key)) continue;
    if (input.existingKeys.has(forfeitKey)) throw new Error('유산 반환·몰수 원장이 짝을 이루지 않습니다.');
    const entry: HeritageRefundEntry = {
      userId: spend.userId,
      worldId: input.worldId,
      key,
      kind: 'CREATION_REFUND',
      delta: -spend.delta,
      detail: { version: 1, sourceKey: spend.key, reason: input.reason },
    };
    result.push(entry);
    if (input.withdrawnUserIds.has(spend.userId))
      result.push({ ...entry, key: forfeitKey, kind: 'FORFEIT', delta: -entry.delta });
  }
  return result;
}
