import { z } from 'zod';

const removalTick = z.number().int().min(0).max(2_147_483_647);

// null은 기존 장수의 재생 모양과 해시에 추가하지 않는다.
export function storedGeneralRemoval<T extends object>(row: T & { removedAt?: unknown }, format: number) {
  const { removedAt, ...general } = row;
  if (removedAt == null) return general;
  if (format !== 3) throw Error('장수 내보내기는 형식3 월드에서만 저장할 수 있습니다.');
  return { ...general, removedAt: removalTick.parse(removedAt) };
}
