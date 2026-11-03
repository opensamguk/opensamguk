import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import { OFFICE_LABEL } from '../governance/governanceModel';
import { officerName } from '../game/names';

// 가문 API 계약의 화면 쪽 타입과 표시 도움 함수 (T4-95, AC-P2-32).
// 자격·사유·미리보기는 lineage.get이 준 값만 쓴다. 화면은 성별·나이로 거르거나 판정하지 않는다.
export type LineageBoard = inferRouterOutputs<AppRouter>['lineage']['get'];
export type LineageView = LineageBoard['view'];
export type LineagePerson = LineageView['people'][number];
export type LineageMarriage = LineageView['marriages'][number];
export type LineageMine = NonNullable<LineageView['mine']>;
export type LineageOffer = LineageMine['offers'][number];
export type LineageFailure = NonNullable<LineageMine['marriageCandidates'][number]['failure']>;
export type SuccessionPreview = NonNullable<LineageMine['preview']>;
export type LineageRequestResult = inferRouterOutputs<AppRouter>['lineage']['request'];
export type LineageInput = inferRouterInputs<AppRouter>['lineage']['submit']['payload'];
export type LineageSex = LineagePerson['sex'];

export const SEX_LABEL: Record<LineageSex, string> = { MALE: '남', FEMALE: '여', UNKNOWN: '미상' };

// 혼인 후보의 막힘 코드를 짧게 묶어 센다. 자세한 문구는 서버 message를 그대로 보인다.
export const FAILURE_LABEL: Record<string, string> = {
  SELF: '자기 자신',
  BAD_TARGET: '미등장·퇴장',
  SEX_UNKNOWN: '성별 미상',
  SEX_PAIR: '같은 성별',
  AGE: '나이 조건',
  KIN: '가까운 혈연',
  ALREADY_MARRIED: '혼인 상한',
  OFFER_PENDING: '제안 대기 중',
  NPC_REFUSED: 'NPC 조건',
  LIMIT: '제안 상한',
};
export const failureLabel = (failure: { code: string }) => FAILURE_LABEL[failure.code] ?? failure.code;

export const formatCount = (value: number) => value.toLocaleString('ko-KR');
export const personOf = (view: LineageView, id: number | null) =>
  id === null ? undefined : view.people.find((row) => row.id === id);
export const personName = (view: LineageView, id: number | null) =>
  id === null ? '—' : (personOf(view, id)?.name ?? `장수 ${id}`);
export const nationOf = (view: LineageView, id: number | null) =>
  id === null ? undefined : view.nations.find((row) => row.id === id);
export const cityName = (view: LineageView, key: number) =>
  view.cities.find((row) => row.cityKey === key)?.name ?? `거점 ${key}`;

// 나이·위치·직책·사람 여부·등장 연도·초상은 서버가 내 장수와 같은 국가 장수에게만 준다(visibility(viewer).general).
// 다른 인물은 이 칸이 없다. 빠지면 모름으로 두고 다른 값으로 짐작하지 않는다.
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
export const personAge = (person: LineagePerson): number | null => (integer(person.age) ? person.age : null);
export const personCity = (view: LineageView, person: LineagePerson): string | null =>
  integer(person.cityKey) ? cityName(view, person.cityKey) : null;
export const personOffice = (person: LineagePerson): string | null =>
  integer(person.officerLevel) ? officerName(person.officerLevel, person.nationId !== null) : null;
export const personPortrait = (person: LineagePerson): number | null =>
  integer(person.portraitId) ? person.portraitId : null;
// 제안 당사자만 받는 값이다. 제안한 장수(가주)의 지금 도시로, 수락 때 자녀가 따를 도시를 보인다.
export const offerHouseholdCity = (view: LineageView, offer: LineageOffer): string | null =>
  integer(offer.householdCityKey) ? cityName(view, offer.householdCityKey) : null;

export const spouseOf = (row: LineageMarriage, id: number) => (row.a === id ? row.b : row.a);
export const marriagesOf = (view: LineageView, id: number) =>
  view.marriages.filter((row) => row.a === id || row.b === id);

// 가계 한 칸: 가주와 다른 부모, 지금 혼인(끝났으면 null), 자녀. 혼인이 끝나도(퇴장) 자녀의 parents로 남는다.
export type Family = { household: number; other: number; marriage: LineageMarriage | null; children: number[] };
export function families(view: LineageView): Family[] {
  const map = new Map<string, Family>();
  const get = (household: number, other: number) => {
    const key = `${household}:${other}`;
    let row = map.get(key);
    if (!row) map.set(key, (row = { household, other, marriage: null, children: [] }));
    return row;
  };
  for (const row of view.marriages) get(row.householdGeneralId, spouseOf(row, row.householdGeneralId)).marriage = row;
  for (const person of view.people)
    if (person.parents.length === 2) get(person.parents[0]!, person.parents[1]!).children.push(person.id);
  return [...map.values()];
}

// 내 가계의 뿌리: 가주 부모 쪽으로 올라간 맨 위 장수. 고리가 있어도 멈춘다.
export function familyRoot(view: LineageView, id: number) {
  const seen = new Set([id]);
  let root = id;
  for (;;) {
    const parent = personOf(view, root)?.parents[0];
    if (parent === undefined || seen.has(parent)) return root;
    seen.add(parent);
    root = parent;
  }
}

// 머리 칸의 다음 할 일. 군주 청구 → 받은 제안 → 후계 → 혼인 후보 순서다. 판정은 get 응답 그대로 쓴다.
export type LineageTab = 'family' | 'marriage' | 'offers' | 'succession' | 'history';
export type NextAction = { text: string; tab: LineageTab; target: string; label: string } | { text: string; tab: null };
export function nextAction(view: LineageView): NextAction {
  const mine = view.mine;
  if (!mine) return { text: '장수가 있어야 가문 요청을 보낼 수 있습니다.', tab: null };
  if (mine.claim) {
    const nation = nationOf(view, mine.claim.nationId)?.name ?? `국가 ${mine.claim.nationId}`;
    return {
      text: `${nation} 군주 자리가 비어 있습니다. 원하면 직접 청구할 수 있습니다.`,
      tab: 'succession',
      target: 'claim',
      label: '군주 청구 보기',
    };
  }
  const received = mine.offers.filter((row) => row.toId === mine.generalId).length;
  if (received)
    return {
      text: `받은 혼인 제안 ${formatCount(received)}건에 응답하세요.`,
      tab: 'offers',
      target: 'offers',
      label: '제안 보기',
    };
  if (mine.heirId !== null)
    return {
      text: `후계자 ${personName(view, mine.heirId)} 지정됨. 원할 때 미리보기를 보고 직접 확정합니다.`,
      tab: 'succession',
      target: 'preview',
      label: '계승 미리보기',
    };
  if (mine.heirCandidates.some((row) => row.failure === null))
    return {
      text: '후계자를 지정해 둘 수 있습니다. 지정만으로는 계승되지 않습니다.',
      tab: 'succession',
      target: 'heir',
      label: '후계자 고르기',
    };
  if (!marriagesOf(view, mine.generalId).length && mine.marriageCandidates.some((row) => row.failure === null))
    return { text: '혼인할 수 있는 장수가 있습니다.', tab: 'marriage', target: 'marriage', label: '혼인 후보 보기' };
  return { text: '지금 할 일이 없습니다.', tab: null };
}

const list = (ids: readonly number[], label: (id: number) => string) => (ids.length ? ids.map(label) : ['없음']);

// 계승 미리보기 표의 줄. 보내는 expected와 같은 값이며 화면은 이름만 붙인다.
export function previewRows(view: LineageView, preview: SuccessionPreview): Array<[string, string[]]> {
  const name = (id: number) => personName(view, id);
  const governance = [
    preview.governance.throne ? '황위: 폐위됩니다' : '황위: 해당 없음',
    preview.governance.courtOffice
      ? `조정 직위 ${OFFICE_LABEL[preview.governance.courtOffice]}: 해임됩니다`
      : '조정 직위: 해당 없음',
    ...preview.governance.vassalIds.map((id) => `봉신 계약 ${id}번: 해제됩니다`),
  ];
  return [
    ['조작', [`이 계정이 ${name(preview.heirId)}을(를) 조작합니다. 지금 장수는 은퇴하고 되돌릴 수 없습니다.`]],
    ['직책', [`${name(preview.heirId)}: ${officerName(preview.officerLevel)}`]],
    ['금·쌀', [`금 ${formatCount(preview.gold)} · 쌀 ${formatCount(preview.rice)} (계승 뒤 후계자 보유량)`]],
    ['병력', [`${formatCount(preview.crew)}명 (본대와 소유 부곡 합계)`]],
    ['부곡', list(preview.unitIds, (id) => `부곡 ${id}`)],
    ['휘하 유지', list(preview.keptRetinue, name)],
    ['휘하 해제', list(preview.releasedRetinue, name)],
    ['취소되는 지시', list(preview.cancelledOrders, (id) => `지시 ${id}번`)],
    [
      '닫히는 제안',
      preview.cancelledOffers.length
        ? preview.cancelledOffers.map((row) => `${row.kind === 'RETINUE' ? '휘하 제안' : '발령 제안'} ${row.id}`)
        : ['없음'],
    ],
    ['황실', governance],
    ['예턴', [`${name(preview.heirId)}의 개인 예턴 30칸과, 조작자가 바뀐 국가 예턴 칸이 비워집니다.`]],
  ];
}

export function describeAction(view: LineageView, payload: LineageInput): string {
  switch (payload.type) {
    case 'marriage.propose':
      return `혼인 제안 · ${personName(view, payload.targetGeneralId)}`;
    case 'marriage.respond': {
      const offer = view.mine?.offers.find((row) => row.id === payload.offerId);
      return `혼인 제안 ${payload.accept ? '수락' : '거절'}${offer ? ` · ${personName(view, offer.fromId)}` : ` (${payload.offerId}번)`}`;
    }
    case 'heir.designate':
      return payload.heirGeneralId === null
        ? '후계 지정 해제'
        : `후계자 지정 · ${personName(view, payload.heirGeneralId)}`;
    case 'succession.confirm':
      return `계승 확정 · ${personName(view, payload.heirGeneralId)}`;
    case 'ruler.claim':
      return `군주 청구 · ${nationOf(view, payload.nationId)?.name ?? `국가 ${payload.nationId}`}`;
  }
}

// 혼인 제안의 처리 방식. 상대가 사람이면 제안이 가고 본인이 수락해야 하며, NPC면 처리할 때 조건으로 바로 판정한다.
// 사람 여부는 lineage.get people[].isHuman 그대로다. 처리 때 다시 판정하므로 그사이 바뀌면 결과가 다를 수 있다.
// 다른 국가 장수처럼 isHuman이 없으면 NPC로 짐작하지 않고 두 경우를 모두 적는다.
export function proposalRule(view: LineageView, targetId: number): string {
  const target = personOf(view, targetId);
  if (!target || typeof target.isHuman !== 'boolean')
    return `처리할 때 ${target ? `${target.name}이(가) ` : '상대가 '}사람 장수면 제안이 가고 직접 수락해야 혼인합니다. NPC면 소속·친화 조건으로 바로 판정합니다.`;
  return target.isHuman
    ? `${target.name}은(는) 사람 장수입니다. 제안이 가고 상대가 기한 안에 직접 수락해야 혼인합니다. 자동으로 수락되지 않습니다.`
    : `${target.name}은(는) NPC입니다. 처리할 때 소속·친화 조건으로 바로 판정하고 맞으면 제안 없이 바로 혼인합니다.`;
}

// 미등장 인물의 등장 연도. 퇴장했거나 이미 등장했거나, 서버가 정수 연도를 주지 않았으면 null이다.
export const comingOfAgeYear = (person: LineagePerson): number | null =>
  person.active || person.exit || !integer(person.activeFromYear) ? null : person.activeFromYear;

export function appliedMessage(view: LineageView, payload: LineageInput, action: LineageInput['type']): string {
  const target = payload.type === 'marriage.propose' ? personOf(view, payload.targetGeneralId) : undefined;
  if (!target || typeof target.isHuman !== 'boolean') return APPLIED_MESSAGE[action];
  return target.isHuman
    ? `${target.name}에게 혼인 제안을 보냈습니다. 상대가 직접 수락해야 혼인합니다. 제안 탭에서 확인하세요.`
    : `${target.name}(NPC)과(와) 혼인했습니다. 혼인 탭에서 확인하세요.`;
}

export const APPLIED_MESSAGE: Record<LineageInput['type'], string> = {
  'marriage.propose':
    '혼인 요청을 처리했습니다. 사람 장수에게는 제안이 갔고 NPC와는 혼인했습니다. 혼인·제안 탭에서 확인하세요.',
  'marriage.respond': '혼인 제안에 응답했습니다.',
  'heir.designate': '후계 지정을 바꿨습니다. 지정만으로는 계승되지 않습니다.',
  'succession.confirm': '계승했습니다. 이제 이 계정은 후계자를 조작합니다. 다른 칸에 열어 둔 양식은 다시 확인하세요.',
  'ruler.claim': '군주 자리를 이었습니다. 국가 예턴의 군주 칸이 내 칸이 됩니다.',
};
