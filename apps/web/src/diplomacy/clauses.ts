import { NON_AGGRESSION_MONTHS, NOTE_MAX_LENGTH, type Clause, type ClauseKind, type Relation } from './contract';
import type { MapCity, MapNation } from '../game/types';

// 조약서 쓰기의 순수 계산. 화면 검사는 보내기 전에 돕는 것이고 최종 판단은 서버(quote·엔진)가 한다.
export const TREATY_MAX_MONTHS = 120;
export const TRIBUTE_MAX_AMOUNT = 10_000;

export const emptyExpandedClauses = () => ({
  passage: { on: false, months: '12', cityKeys: [] as number[] },
  tribute: { on: false, months: '12', payerNationId: null as number | null, gold: '0', rice: '0' },
  cityTransfer: { on: false, cityKey: null as number | null, giverNationId: null as number | null },
});

export interface ComposeState extends ReturnType<typeof emptyExpandedClauses> {
  toNationId: number | null;
  peace: boolean;
  nonAggression: { on: boolean; months: string };
  note: { on: boolean; text: string };
  trade?: { on: boolean; months: string };
}

export const emptyCompose = (): ComposeState => ({
  toNationId: null,
  peace: false,
  nonAggression: { on: false, months: '24' },
  note: { on: false, text: '' },
  trade: { on: false, months: '24' },
  ...emptyExpandedClauses(),
});

export const CLAUSE_LABELS: Record<ClauseKind, string> = {
  peace: '종전',
  nonAggression: '불가침',
  note: '기록만 남길 약속',
  trade: '교역 허용',
  passage: '통행 허용',
  tribute: '정기 원조',
  cityTransfer: '도시 이양',
};

// 이 편집기에서 아직 선택하지 않는 조항. 서버 지원은 월드의 기능 선택에 따른다.
export const UNSUPPORTED_CLAUSE_LABELS = ['통행 허용', '정기 원조', '교역 허용', '도시 이양'] as const;
export const UNSUPPORTED_CLAUSE_REASON = '아직 지원하지 않는 조항입니다.';

// 종전은 교전 중이거나 선포한 사이에서만 고른다 (서버 TreatyTarget.relation).
export const canChoosePeace = (relation: Relation | undefined) => relation === 'WAR' || relation === 'DECLARED';

const positiveInt = (raw: string) => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 1 ? n : null;
};
const boundedAmount = (raw: string) => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= TRIBUTE_MAX_AMOUNT ? n : null;
};

export type ClauseCity = Pick<MapCity, 'key' | 'name' | 'nationId' | 'kind'>;
export type ClauseNation = Pick<MapNation, 'id' | 'name' | 'capitalCityKey'>;
export function clauseCities(cities: readonly ClauseCity[], parties: readonly ClauseNation[]) {
  const passage = cities.filter(
    (city) => city.kind !== 'PASS' && parties.some((nation) => nation.id === city.nationId),
  );
  const transfer = passage.filter((city) => {
    const owner = parties.find((nation) => nation.id === city.nationId);
    return (
      owner &&
      city.key !== owner.capitalCityKey &&
      passage.some((capital) => capital.key === owner.capitalCityKey && capital.nationId === owner.id)
    );
  });
  return { passage, transfer };
}

// 서버는 약속 문장을 NFC로 바꾼 뒤 코드포인트로 센다.
export const noteLength = (text: string) => [...text.normalize('NFC')].length;

export interface BuiltClauses {
  clauses: Clause[];
  // 보내기 전에 고칠 것. 비어 있어야 제안을 보낸다.
  problems: string[];
}

// 폼 값을 조항 목록으로 바꾼다. 순서는 서버 저장 순서(종전·불가침·약속)와 같다.
export function buildClauses(
  state: ComposeState,
  relation: Relation | undefined,
  options?: { parties: readonly ClauseNation[]; cities: ReturnType<typeof clauseCities> },
): BuiltClauses {
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
  if (state.trade?.on) {
    const months = positiveInt(state.trade.months);
    if (months === null || months < 1 || months > 120) problems.push('교역 기간은 1~120개월입니다.');
    else clauses.push({ kind: 'trade', months });
  }
  if (options && state.passage.on) {
    const months = positiveInt(state.passage.months);
    const cityKeys = [...new Set(state.passage.cityKeys)].sort((a, b) => a - b);
    if (months === null || months > TREATY_MAX_MONTHS) problems.push('통행 기간은 1~120개월입니다.');
    else if (!cityKeys.length || cityKeys.some((key) => !options.cities.passage.some((city) => city.key === key)))
      problems.push('양국의 통행 도시를 하나 이상 고르세요.');
    else clauses.push({ kind: 'passage', cityKeys, months });
  }
  if (options && state.tribute.on) {
    const { payerNationId } = state.tribute;
    const months = positiveInt(state.tribute.months);
    const gold = boundedAmount(state.tribute.gold);
    const rice = boundedAmount(state.tribute.rice);
    if (payerNationId === null || !options.parties.some((nation) => nation.id === payerNationId))
      problems.push('원조를 보내는 국가를 고르세요.');
    else if (months === null || months > TREATY_MAX_MONTHS) problems.push('정기 원조 기간은 1~120개월입니다.');
    else if (gold === null || rice === null || gold + rice === 0)
      problems.push('금과 쌀을 각각 0~10,000으로 입력하고 하나 이상을 보내세요.');
    else clauses.push({ kind: 'tribute', payerNationId, gold, rice, months });
  }
  if (options && state.cityTransfer.on) {
    const city = options.cities.transfer.find(({ key }) => key === state.cityTransfer.cityKey);
    if (!city || city.nationId === null || city.nationId !== state.cityTransfer.giverNationId)
      problems.push('이양할 비수도 도시를 고르세요.');
    else clauses.push({ kind: 'cityTransfer', cityKey: city.key, giverNationId: city.nationId });
  }
  if (state.note.on) {
    const text = state.note.text.trim();
    if (text === '') problems.push('기록만 남길 약속의 문장을 쓰세요.');
    else if (noteLength(text) > NOTE_MAX_LENGTH) problems.push(`약속 문장은 ${NOTE_MAX_LENGTH}자까지입니다.`);
    else clauses.push({ kind: 'note', text });
  }

  if (clauses.length === 0 && problems.length === Number(state.toNationId === null))
    problems.push('조항을 하나 이상 고르세요.');
  return { clauses, problems };
}

// 기록만 남는 조항은 note 하나다. 서버 목록에는 집행 여부 칸이 없어 이 표로 나눈다.
export const isEnforced = (kind: ClauseKind) => kind !== 'note';

// 조항 한 줄 요약. 받은 제안 카드와 조약 목록에 쓴다.
export function describeClause(
  clause: Clause,
  labels?: { city: (key: number) => string; nation: (id: number) => string; recipient: (id: number) => string },
): string {
  const city = (key: number) => labels?.city(key) ?? `도시 ${key}`;
  const nation = (id: number) => labels?.nation(id) ?? `국가 ${id}`;
  const recipient = (id: number) => (labels ? ` → ${labels.recipient(id)}` : '');
  switch (clause.kind) {
    case 'peace':
      return '종전';
    case 'nonAggression':
      return `불가침 ${clause.months}개월`;
    case 'note':
      return `기록만 남길 약속 (${clause.text})`;
    case 'trade':
      return `교역 허용 ${clause.months}개월`;
    case 'passage':
      return `통행 허용${clause.months === undefined ? '' : ` ${clause.months}개월`} · ${clause.cityKeys.map(city).join(', ')}`;
    case 'tribute':
      return `정기 원조 ${clause.months}개월 · ${nation(clause.payerNationId)}${recipient(clause.payerNationId)} · 매달 금 ${clause.gold.toLocaleString('ko-KR')} · 쌀 ${clause.rice.toLocaleString('ko-KR')}`;
    case 'cityTransfer':
      return `도시 이양 · ${nation(clause.giverNationId)}의 ${city(clause.cityKey)}${recipient(clause.giverNationId)} · 수락 즉시`;
  }
}
