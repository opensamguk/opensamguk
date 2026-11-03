import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

// 황실 API 계약의 화면 쪽 타입과 표시 도움 함수 (T4-94, AC-P2-31).
// 값·한도는 governance.get이 준 것만 쓴다. 아래 이유 목록은 단추를 막고 까닭을 보이는 안내일 뿐이며
// 최종 판정은 접수(decideGovernanceAction)와 엔진이 한다. 전쟁·제안 수 한도·쿨다운은 조회에 없어 서버가 거부한다.
export type GovernanceBoard = inferRouterOutputs<AppRouter>['governance']['get'];
export type GovernanceView = Extract<GovernanceBoard['view'], { enabled: true }>;
export type GovernanceRequestResult = inferRouterOutputs<AppRouter>['governance']['request'];
export type GovernanceMovementRow = GovernanceBoard['movements'][number];
export type GovernanceOfferRow = GovernanceView['offers'][number];
export type GovernanceVassalRow = GovernanceView['vassals'][number];
export type GovernanceOffice = GovernanceView['court'][number]['office'];
export type GovernanceInput = inferRouterInputs<AppRouter>['governance']['submit']['payload'];

export const OFFICE_LABEL: Record<GovernanceOffice, string> = {
  chancellor: '승상',
  grandMarshal: '대장군',
  minister: '사도',
};
export const OFFICE_POWER: Record<GovernanceOffice, string> = {
  chancellor: '황실 명의 봉신 요구, 황제국이 직접 상위인 관계 해제',
  grandMarshal: '황제국 계열 밖 국가 견책',
  minister: '황제국이 직접 상위인 관계의 공납 면제',
};
// 봉록 원장의 refId는 직위 순서(1부터)다.
const OFFICE_ORDER: readonly GovernanceOffice[] = ['chancellor', 'grandMarshal', 'minister'];
export const officeByRef = (refId: number): GovernanceOffice | null => OFFICE_ORDER[refId - 1] ?? null;

export const formatCount = (value: number) => value.toLocaleString('ko-KR');
// 만분율을 백분율 문구로만 바꾼다.
export const percent = (bp: number) => `${(bp / 100).toFixed(2)}%`;

// 백분율 입력(소수 둘째 자리까지)을 만분율 정수로 읽는다. 부동소수 오차를 피하려고 문자열로 계산한다.
export function readBp(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

// 공개된 활성 관계(상위·하위)로 계열을 계산한다.
export function realm(view: GovernanceView) {
  const parents = new Map(view.vassals.map((row) => [row.vassalNationId, row.overlordNationId]));
  const children = new Map<number, number[]>();
  for (const row of view.vassals)
    children.set(row.overlordNationId, [...(children.get(row.overlordNationId) ?? []), row.vassalNationId]);
  const chain = (id: number) => {
    const out = [id];
    for (let up = parents.get(id); up !== undefined && !out.includes(up); up = parents.get(up)) out.push(up);
    return out;
  };
  const height = (id: number, seen = new Set<number>()): number =>
    seen.has(id) ? 0 : Math.max(0, ...(children.get(id) ?? []).map((kid) => 1 + height(kid, new Set(seen).add(id))));
  return {
    parents,
    children,
    chain,
    root: (id: number) => chain(id).at(-1)!,
    depth: (id: number) => chain(id).length - 1,
    height,
  };
}

export const nationName = (view: GovernanceView, id: number | null) =>
  id === null ? '—' : (view.nations.find((row) => row.id === id)?.name ?? `국가 ${id}`);
export const generalName = (view: GovernanceView, id: number | null) =>
  id === null ? '—' : (view.generals.find((row) => row.id === id)?.name ?? `장수 ${id}`);
export const legitimacyOf = (view: GovernanceView, id: number | null) =>
  id === null ? null : (view.legitimacy.find((row) => row.nationId === id)?.value ?? null);
export const viewerOffice = (view: GovernanceView): GovernanceOffice | null =>
  view.court.find((row) => row.appointment !== null && row.appointment.generalId === view.viewerGeneralId)?.office ??
  null;

export type OfferDraft = {
  authority: 'OWN' | 'EMPIRE';
  target: string;
  direction: 'DEMAND' | 'REQUEST';
  gold: string;
  rice: string;
};

export function offerSources(view: GovernanceView) {
  const own =
    view.roles.monarch && view.ownNationId !== null
      ? { nationId: view.ownNationId, reason: null }
      : { nationId: null, reason: '자국 명의 제안은 자국 군주만 보낼 수 있습니다.' };
  const empire =
    (view.roles.emperor || view.roles.chancellor) && view.throne.emperorNationId !== null
      ? { nationId: view.throne.emperorNationId, reason: null }
      : { nationId: null, reason: '황실 명의 제안은 황제나 승상만 보낼 수 있습니다.' };
  return { OWN: own, EMPIRE: empire };
}

export function offerCheck(view: GovernanceView, draft: OfferDraft) {
  const reasons: string[] = [];
  const source = offerSources(view)[draft.authority];
  if (source.reason) reasons.push(source.reason);
  if (draft.authority === 'EMPIRE' && draft.direction === 'REQUEST')
    reasons.push('황실 명의로는 요구(상대가 봉신이 됨)만 보낼 수 있습니다.');
  const target = view.nations.find((row) => String(row.id) === draft.target)?.id ?? null;
  if (target === null) reasons.push('상대 국가를 고르세요.');
  const gold = readBp(draft.gold),
    rice = readBp(draft.rice);
  const max = view.limits.maxBp;
  if (gold === null || rice === null || gold > max || rice > max)
    reasons.push(`금·쌀 비율은 각각 0~${percent(max)}, 소수 둘째 자리까지 넣으세요.`);
  let upper: number | null = null,
    lower: number | null = null;
  if (source.nationId !== null && target !== null) {
    if (target === source.nationId) reasons.push('자기 국가에는 제안할 수 없습니다.');
    else {
      [upper, lower] = draft.direction === 'DEMAND' ? [source.nationId, target] : [target, source.nationId];
      reasons.push(...unionReasons(view, upper, lower));
    }
  }
  const payload: GovernanceInput | null =
    reasons.length === 0 && target !== null && gold !== null && rice !== null
      ? {
          type: 'vassal.offer',
          authority: draft.authority,
          targetNationId: target,
          direction: draft.direction,
          goldBp: gold,
          riceBp: rice,
        }
      : null;
  return { reasons: [...new Set(reasons)], source: source.nationId, target, upper, lower, payload };
}

// 공개 관계만으로 알 수 있는 계약 불가 이유. 전쟁 여부는 조회에 없어 서버가 판정한다.
export function unionReasons(view: GovernanceView, upper: number, lower: number): string[] {
  const tree = realm(view);
  if (lower === view.throne.emperorNationId) return ['황제국은 다른 국가의 봉신이 될 수 없습니다.'];
  if (tree.parents.has(lower)) return [`${nationName(view, lower)}에는 이미 상위 국가가 있습니다.`];
  if (tree.chain(upper).includes(lower)) return ['서로 같은 계열이라 계약하면 순환이 생깁니다.'];
  const depth = tree.depth(upper) + 1 + tree.height(lower);
  if (depth > view.limits.maxDepth)
    return [`수락되면 계열 깊이가 ${depth}단계로 최대 ${view.limits.maxDepth}단계를 넘습니다.`];
  return [];
}

// 관계 하나에 지금 보는 장수가 할 수 있는 일. reason이 있으면 단추 대신 이유를 보인다.
export type Availability = { reason: string | null } | null;
export function vassalActions(view: GovernanceView, row: GovernanceVassalRow) {
  const own = view.ownNationId;
  const direct = row.overlordNationId === view.throne.emperorNationId;
  // 위임 직위는 자국이 이 관계의 하위국이거나 그 아래 계열이면 쓸 수 없다(이탈 비용 회피 방지).
  const ownBranch = own !== null && realm(view).chain(own).includes(row.vassalNationId);
  const overlordMonarch = view.roles.monarch && own === row.overlordNationId;
  let release: Availability = null;
  if (overlordMonarch) release = { reason: null };
  else if (view.roles.chancellor && direct)
    release = {
      reason: ownBranch ? '승상은 자국이 하위국이거나 그 아래 계열인 관계를 해제할 수 없습니다.' : null,
    };
  const renounce: Availability =
    view.roles.monarch && own === row.vassalNationId
      ? { reason: row.renouncePending ? '이미 이탈을 요청했습니다. 다음 월 정산에 끝납니다.' : null }
      : null;
  let remit: Availability = null;
  if (direct && view.roles.emperor) remit = { reason: null };
  else if (direct && view.roles.minister)
    remit = {
      reason: ownBranch ? '사도는 자국이 하위국이거나 그 아래 계열인 관계의 공납을 면제할 수 없습니다.' : null,
    };
  return { release, renounce, remit, direct, ownBranch };
}

// 봉신 탭의 앞자리. 내 계열(자국 최상위국과 그 아래 전부)과, 자국이 당사국이거나 내가 행동할 수 있는 관계만 고른다.
// 나머지 공개 계열도·관계는 화면에서 접어 둘 뿐 지우지 않는다. 행동이 있는 관계는 언제나 앞자리에 둔다.
export function realmScope(view: GovernanceView) {
  const tree = realm(view);
  const own = view.ownNationId;
  const root = own === null ? null : tree.root(own);
  const members = new Set<number>();
  const walk = (id: number) => {
    if (members.has(id)) return;
    members.add(id);
    for (const kid of tree.children.get(id) ?? []) walk(kid);
  };
  if (root !== null) walk(root);
  const isMine = (row: GovernanceVassalRow) => {
    if (members.has(row.vassalNationId)) return true;
    const can = vassalActions(view, row);
    return can.release !== null || can.renounce !== null || can.remit !== null;
  };
  return {
    root,
    members,
    tops: view.nations.filter((row) => !tree.parents.has(row.id)).map((row) => row.id),
    mine: view.vassals.filter(isMine),
    others: view.vassals.filter((row) => !isMine(row)),
  };
}

export function censureTargets(view: GovernanceView) {
  const empire = view.throne.emperorNationId;
  if (empire === null) return [];
  const tree = realm(view);
  return view.nations.filter((row) => tree.root(row.id) !== tree.root(empire));
}

export function splitOffers(view: GovernanceView) {
  const received = view.offers.filter((offer) =>
    offer.kind === 'VASSAL'
      ? view.roles.monarch && offer.targetNationId === view.ownNationId
      : offer.targetGeneralId === view.viewerGeneralId,
  );
  return { received, sent: view.offers.filter((offer) => !received.includes(offer)) };
}

export function describeAction(view: GovernanceView, payload: GovernanceInput): string {
  switch (payload.type) {
    case 'throne.ascend':
      return '즉위';
    case 'throne.abdicate':
      return '퇴위';
    case 'vassal.offer':
      return `봉신 ${payload.direction === 'DEMAND' ? '요구' : '청원'} · ${nationName(view, payload.targetNationId)}`;
    case 'vassal.respond':
      return `봉신 제안 ${payload.accept ? '수락' : '거절'} (${payload.offerId}번)`;
    case 'vassal.release':
      return `봉신 관계 해제 (${payload.vassalId}번 계약)`;
    case 'vassal.renounce':
      return `봉신 이탈 (${payload.vassalId}번 계약)`;
    case 'court.offer':
      return `${OFFICE_LABEL[payload.office]} 임명 제안 · ${generalName(view, payload.generalId)}`;
    case 'court.respond':
      return `직위 제안 ${payload.accept ? '수락' : '거절'} (${payload.offerId}번)`;
    case 'court.dismiss':
      return `${OFFICE_LABEL[payload.office]} 해임`;
    case 'court.resign':
      return '직위 사임';
    case 'court.remit':
      return `공납 면제 ${payload.months}개월 (${payload.vassalId}번 계약)`;
    case 'court.censure':
      return `견책 · ${nationName(view, payload.nationId)}`;
  }
}

export const APPLIED_MESSAGE: Record<GovernanceInput['type'], string> = {
  'throne.ascend': '즉위했습니다.',
  'throne.abdicate': '퇴위했습니다. 조정 세 직위도 비워졌습니다.',
  'vassal.offer': '봉신 제안을 보냈습니다. 제안 탭의 보낸 제안에서 봅니다.',
  'vassal.respond': '봉신 제안에 응답했습니다.',
  'vassal.release': '봉신 관계를 해제했습니다.',
  'vassal.renounce': '이탈을 요청했습니다. 다음 월 정산에 관계가 끝납니다.',
  'court.offer': '임명 제안을 보냈습니다.',
  'court.respond': '직위 제안에 응답했습니다.',
  'court.dismiss': '직위를 해임했습니다.',
  'court.resign': '직위에서 사임했습니다.',
  'court.remit': '공납 면제를 적용했습니다.',
  'court.censure': '견책했습니다.',
};
