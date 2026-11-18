// 서버 도시 값을 성 화면 상황(cityTalk/common.json situations와 LOCAL situation 키)으로 바꾼다.
// 도시 상태 번호는 packages/rules/src/monthly/disaster.ts(1 풍작, 2 호황, 3 혹한, 4 역병, 5 지진, 6 태풍, 7 홍수,
// 8 메뚜기와 흉년, 9 황건적)와 공격받는 도시(41~43, commands/attack.ts가 43을 쓴다)를 따른다.
// 민심, 치안 기준은 시안(castle-panorama activeConds)과 같다: 민심 75 이상 loved, 35 이하 unhappy, 치안 40% 이하 unsafe.
export interface CityValues {
  state?: number | undefined;
  trust?: number | undefined;
  security?: number | undefined;
  securityMax?: number | undefined;
  supplied?: boolean | undefined;
  /** 폐허 표시(서버 ruin). 있으면 폐허. */
  ruin?: unknown;
}

const STATE_COND: Readonly<Record<number, string>> = {
  1: 'harvest',
  2: 'boom',
  3: 'cold',
  4: 'plague',
  5: 'quake',
  6: 'typhoon',
  7: 'flood',
  8: 'locust',
  9: 'bandits',
};

export function cityConditions(city: CityValues | null | undefined): string[] {
  if (!city) return [];
  const out: string[] = [];
  const state = city.state ?? 0;
  if (STATE_COND[state]) out.push(STATE_COND[state]!);
  if (state >= 41 && state <= 43) out.push('battle');
  if (city.supplied === false) out.push('unsupplied');
  if (city.ruin) out.push('ruin');
  if (city.trust !== undefined) {
    if (city.trust >= 75) out.push('loved');
    if (city.trust <= 35) out.push('unhappy');
  }
  if (city.security !== undefined && city.securityMax) {
    if (city.security / city.securityMax <= 0.4) out.push('unsafe');
  }
  return out;
}

/** 게임 달(1~12)의 계절. 1~3월 봄, 4~6월 여름, 7~9월 가을, 10~12월 겨울(재해 표의 분기와 같다). */
export function seasonOf(month: number | undefined): 'spring' | 'summer' | 'autumn' | 'winter' {
  const m = month ?? 1;
  return m <= 3 ? 'spring' : m <= 6 ? 'summer' : m <= 9 ? 'autumn' : 'winter';
}
