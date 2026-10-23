import { NON_AGGRESSION_MONTHS, NOTE_MAX_LENGTH, type Clause, type ClauseKind, type Relation } from './contract';

// 조약서 쓰기의 순수 계산. 화면 검사는 보내기 전에 돕는 것이고 최종 판단은 서버(quote·엔진)가 한다.

export type Side = 'us' | 'them';

export interface ComposeState {
  toNationId: number | null;
  peace: boolean;
  nonAggression: { on: boolean; months: string };
  passage: { on: boolean; cityKeys: number[] };
  tribute: { on: boolean; payer: Side; gold: string; rice: string; months: string };
  trade: { on: boolean; months: string };
  cityTransfer: { on: boolean; giver: Side; cityKey: number | null };
  note: { on: boolean; text: string };
}

export const emptyCompose = (): ComposeState => ({
  toNationId: null,
  peace: false,
  nonAggression: { on: false, months: '24' },
  passage: { on: false, cityKeys: [] },
  tribute: { on: false, payer: 'us', gold: '500', rice: '0', months: '12' },
  trade: { on: false, months: '12' },
  cityTransfer: { on: false, giver: 'us', cityKey: null },
  note: { on: false, text: '' },
});

export const CLAUSE_LABELS: Record<ClauseKind, string> = {
  peace: '종전',
  nonAggression: '불가침',
  passage: '통행 허용',
  tribute: '정기 원조',
  trade: '교역 허용',
  cityTransfer: '도시 이양',
  note: '기록만 남길 약속',
};

// 종전은 교전 중이거나 선포한 사이에서만 고른다 (T2-07 TreatyTarget.relation).
export const canChoosePeace = (relation: Relation | undefined) => relation === 'WAR' || relation === 'DECLARED';

const positiveInt = (raw: string) => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
};
const nonNegativeInt = (raw: string) => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
};

export interface BuiltClauses {
  clauses: Clause[];
  // 보내기 전에 고칠 것. 비어 있어야 제안을 보낸다.
  problems: string[];
}

// 폼 값을 조항 목록으로 바꾼다. 조항 순서는 화면 순서와 같고 quote의 problems[].index가 이 순서를 가리킨다.
export function buildClauses(state: ComposeState, myNationId: number, relation: Relation | undefined): BuiltClauses {
  const clauses: Clause[] = [];
  const problems: string[] = [];
  const them = state.toNationId;
  if (them === null) problems.push('상대 국가를 고르세요.');

  if (state.peace) {
    if (canChoosePeace(relation)) clauses.push({ kind: 'peace' });
    else problems.push('종전은 교전 중이거나 선포한 상대에게만 제안합니다.');
  }
  if (state.nonAggression.on) {
    const months = positiveInt(state.nonAggression.months);
    if (months === null || months < NON_AGGRESSION_MONTHS.min || months > NON_AGGRESSION_MONTHS.max)
      problems.push(`불가침 기간은 ${NON_AGGRESSION_MONTHS.min}~${NON_AGGRESSION_MONTHS.max}개월입니다.`);
    else clauses.push({ kind: 'nonAggression', months });
  }
  if (state.passage.on) {
    if (state.passage.cityKeys.length === 0) problems.push('통행을 허용할 우리 도시를 고르세요.');
    else clauses.push({ kind: 'passage', cityKeys: [...state.passage.cityKeys].sort((a, b) => a - b) });
  }
  if (state.tribute.on) {
    const gold = nonNegativeInt(state.tribute.gold);
    const rice = nonNegativeInt(state.tribute.rice);
    const months = positiveInt(state.tribute.months);
    if (gold === null || rice === null) problems.push('정기 원조의 금·쌀은 0 이상의 정수입니다.');
    else if (gold === 0 && rice === 0) problems.push('정기 원조는 금이나 쌀 중 하나는 넣으세요.');
    if (months === null) problems.push('정기 원조 기간은 1개월 이상입니다.');
    if (gold !== null && rice !== null && (gold > 0 || rice > 0) && months !== null && them !== null)
      clauses.push({
        kind: 'tribute',
        payerNationId: state.tribute.payer === 'us' ? myNationId : them,
        gold,
        rice,
        months,
      });
  }
  if (state.trade.on) {
    const months = positiveInt(state.trade.months);
    if (months === null) problems.push('교역 허용 기간은 1개월 이상입니다.');
    else clauses.push({ kind: 'trade', months });
  }
  if (state.cityTransfer.on) {
    if (state.cityTransfer.cityKey === null) problems.push('이양할 도시를 고르세요.');
    else if (them !== null)
      clauses.push({
        kind: 'cityTransfer',
        cityKey: state.cityTransfer.cityKey,
        giverNationId: state.cityTransfer.giver === 'us' ? myNationId : them,
      });
  }
  if (state.note.on) {
    const text = state.note.text.trim();
    if (text === '') problems.push('기록만 남길 약속의 문장을 쓰세요.');
    else if (text.length > NOTE_MAX_LENGTH) problems.push(`약속 문장은 ${NOTE_MAX_LENGTH}자까지입니다.`);
    else clauses.push({ kind: 'note', text });
  }

  const chosen =
    state.peace ||
    state.nonAggression.on ||
    state.passage.on ||
    state.tribute.on ||
    state.trade.on ||
    state.cityTransfer.on ||
    state.note.on;
  if (!chosen) problems.push('조항을 하나 이상 고르세요.');
  return { clauses, problems };
}

// 기록만 남는 조항은 note 하나다. 서버 응답에는 enforced가 따로 오지만 쓰는 중에는 이 표로 보여 준다.
export const isEnforced = (kind: ClauseKind) => kind !== 'note';

export interface ClauseNames {
  nation: (id: number) => string;
  city: (key: number) => string;
}

// 조항 한 줄 요약. 받은 제안 카드와 조약 목록에 쓴다. 도시 이름은 서버가 준 cityNames를 먼저 쓴다.
export function describeClause(clause: Clause & { cityNames?: string[] }, names: ClauseNames): string {
  switch (clause.kind) {
    case 'peace':
      return '종전';
    case 'nonAggression':
      return `불가침 ${clause.months}개월`;
    case 'passage':
      return `통행 허용 (${(clause.cityNames ?? clause.cityKeys.map(names.city)).join(', ')})`;
    case 'tribute':
      return `정기 원조 (${names.nation(clause.payerNationId)} 부담, 매월 금 ${clause.gold.toLocaleString('ko-KR')} 쌀 ${clause.rice.toLocaleString('ko-KR')}, ${clause.months}개월)`;
    case 'trade':
      return `교역 허용 ${clause.months}개월`;
    case 'cityTransfer':
      return `도시 이양 (${clause.cityNames?.[0] ?? names.city(clause.cityKey)}, 넘기는 쪽 ${names.nation(clause.giverNationId)})`;
    case 'note':
      return `기록만 남길 약속 (${clause.text})`;
  }
}
