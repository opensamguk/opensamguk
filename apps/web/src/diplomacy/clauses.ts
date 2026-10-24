import { NON_AGGRESSION_MONTHS, NOTE_MAX_LENGTH, type Clause, type ClauseKind, type Relation } from './contract';

// 조약서 쓰기의 순수 계산. 화면 검사는 보내기 전에 돕는 것이고 최종 판단은 서버(quote·엔진)가 한다.
// 서버가 연결한 조항은 종전·불가침·기록만 남길 약속 셋이다. 나머지 넷은 고를 수 없게 보이기만 한다.

export interface ComposeState {
  toNationId: number | null;
  peace: boolean;
  nonAggression: { on: boolean; months: string };
  note: { on: boolean; text: string };
}

export const emptyCompose = (): ComposeState => ({
  toNationId: null,
  peace: false,
  nonAggression: { on: false, months: '24' },
  note: { on: false, text: '' },
});

export const CLAUSE_LABELS: Record<ClauseKind, string> = {
  peace: '종전',
  nonAggression: '불가침',
  note: '기록만 남길 약속',
};

// 아직 서버가 받지 않는 조항. 보내면 quote와 엔진이 CLAUSE_NOT_CONNECTED로 거절한다. 다른 조항으로 바꿔 보내지 않는다.
export const UNSUPPORTED_CLAUSE_LABELS = ['통행 허용', '정기 원조', '교역 허용', '도시 이양'] as const;
export const UNSUPPORTED_CLAUSE_REASON = '아직 지원하지 않는 조항입니다.';

// 종전은 교전 중이거나 선포한 사이에서만 고른다 (서버 TreatyTarget.relation).
export const canChoosePeace = (relation: Relation | undefined) => relation === 'WAR' || relation === 'DECLARED';

const positiveInt = (raw: string) => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
};

// 서버는 약속 문장을 NFC로 바꾼 뒤 코드포인트로 센다.
export const noteLength = (text: string) => [...text.normalize('NFC')].length;

export interface BuiltClauses {
  clauses: Clause[];
  // 보내기 전에 고칠 것. 비어 있어야 제안을 보낸다.
  problems: string[];
}

// 폼 값을 조항 목록으로 바꾼다. 순서는 서버 저장 순서(종전·불가침·약속)와 같다.
export function buildClauses(state: ComposeState, relation: Relation | undefined): BuiltClauses {
  const clauses: Clause[] = [];
  const problems: string[] = [];
  if (state.toNationId === null) problems.push('상대 국가를 고르세요.');

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
  if (state.note.on) {
    const text = state.note.text.trim();
    if (text === '') problems.push('기록만 남길 약속의 문장을 쓰세요.');
    else if (noteLength(text) > NOTE_MAX_LENGTH) problems.push(`약속 문장은 ${NOTE_MAX_LENGTH}자까지입니다.`);
    else clauses.push({ kind: 'note', text });
  }

  if (!state.peace && !state.nonAggression.on && !state.note.on) problems.push('조항을 하나 이상 고르세요.');
  return { clauses, problems };
}

// 기록만 남는 조항은 note 하나다. 서버 목록에는 집행 여부 칸이 없어 이 표로 나눈다.
export const isEnforced = (kind: ClauseKind) => kind !== 'note';

// 조항 한 줄 요약. 받은 제안 카드와 조약 목록에 쓴다.
export function describeClause(clause: Clause): string {
  switch (clause.kind) {
    case 'peace':
      return '종전';
    case 'nonAggression':
      return `불가침 ${clause.months}개월`;
    case 'note':
      return `기록만 남길 약속 (${clause.text})`;
  }
}
