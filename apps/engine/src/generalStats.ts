import { assertGeneralStatProfile } from '@opensamguk/rules';

// nullable DB 열을 구형 해시에 섞지 않는다. 새 판의 누락은 읽기 실패다.
export function storedGeneralStats<T extends { politics?: number | null; charm?: number | null }>(
  row: T,
  five: boolean,
) {
  const { politics, charm, ...base } = row;
  if (!five && (politics != null || charm != null)) throw new Error('기존 월드에 새 능력치가 저장됐습니다.');
  const general = { ...base, ...(five ? { politics: politics!, charm: charm! } : {}) };
  assertGeneralStatProfile(general, five);
  return general;
}
