export type TreatyAmounts = Readonly<{ from: number; to: number }>;

export type TreatyFeeResult = { ok: true; gold: TreatyAmounts } | { ok: false; gold: TreatyAmounts };

export type TreatyRelation = 'NONE' | 'WAR' | 'DECLARED' | 'NON_AGGRESSION';

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

// 첫 세 조항용이다. 이 함수는 중복 조항과 뒤 조항의 기간 합산을 정하지 않는다.
export function calculateTreatyFee(cityCount: number, nonAggressionMonths: number | null): number {
  nonNegativeSafeInteger(cityCount, 'cityCount');
  if (nonAggressionMonths === null) return 0;
  if (!Number.isInteger(nonAggressionMonths) || nonAggressionMonths < 1 || nonAggressionMonths > 120)
    throw new RangeError('nonAggressionMonths must be an integer between 1 and 120');

  const fee = (BigInt(cityCount) * 100n * BigInt(nonAggressionMonths) + 11n) / 12n;
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('treaty fee exceeds the safe integer range');
  return Number(fee);
}

// 엔진이 같은 트랜잭션 안에서 읽은 국고와 비용으로 부른다. 이 함수는 상태를 저장하지 않는다.
export function settleTreatyFees(gold: TreatyAmounts, cost: TreatyAmounts): TreatyFeeResult {
  nonNegativeSafeInteger(gold.from, 'gold.from');
  nonNegativeSafeInteger(gold.to, 'gold.to');
  nonNegativeSafeInteger(cost.from, 'cost.from');
  nonNegativeSafeInteger(cost.to, 'cost.to');
  if (gold.from < cost.from || gold.to < cost.to) return { ok: false, gold: { ...gold } };
  return { ok: true, gold: { from: gold.from - cost.from, to: gold.to - cost.to } };
}

// Q7 조건만 판정한다. 종전 자체나 다른 관계 조합의 유효성을 뜻하지 않는다.
export function meetsTreatyPeaceRequirement(
  relation: TreatyRelation,
  clauses: Readonly<{ peace: boolean; nonAggression: boolean }>,
): boolean {
  return !clauses.nonAggression || clauses.peace || (relation !== 'WAR' && relation !== 'DECLARED');
}

// 공통 검증을 마친 제안에만 쓴다. 모양·기간·관계 검사 실패는 valid=false로 넘긴다.
// 조항 종류는 빈 배열이 아닌 검증 결과다. 빈 조약과 중복 조항 정책은 이 helper가 정하지 않는다.
export function canNpcAcceptTreaty(proposal: {
  valid: boolean;
  clauseKinds: readonly [string, ...string[]];
  gold: number;
  cost: number;
}): boolean {
  nonNegativeSafeInteger(proposal.gold, 'gold');
  nonNegativeSafeInteger(proposal.cost, 'cost');
  return (
    proposal.valid &&
    proposal.clauseKinds.every((kind) => kind === 'peace' || kind === 'nonAggression' || kind === 'note') &&
    proposal.gold >= proposal.cost
  );
}
