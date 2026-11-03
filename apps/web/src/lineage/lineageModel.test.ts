import { expect, it } from 'vitest';
import {
  APPLIED_MESSAGE,
  appliedMessage,
  comingOfAgeYear,
  offerHouseholdCity,
  personAge,
  personCity,
  personOffice,
  personPortrait,
  proposalRule,
  type LineageOffer,
  type LineagePerson,
  type LineageView,
} from './lineageModel';

// 세부 칸이 빠진(다른 국가) 인물을 모름으로 다루는지만 본다. 공개 범위 판정은 서버 visibility 시험이 맡는다.
const base = {
  nationId: 2,
  sex: 'MALE' as const,
  active: true,
  parents: [],
  bornTick: null,
  successorId: null,
  exit: null,
};
const hidden: LineagePerson = { id: 12, name: '도겸', ...base };
const own: LineagePerson = {
  id: 10,
  name: '서윤',
  ...base,
  nationId: 1,
  portraitId: 3,
  cityKey: 7,
  isHuman: false,
  activeFromYear: 170,
  age: 20,
  officerLevel: 12,
};
const view = {
  actorId: 10,
  focusId: 10,
  year: 190,
  startYear: 190,
  cities: [{ cityKey: 7, name: '낙양' }],
  people: [own, hidden],
  nations: [],
  marriages: [],
  mine: null,
} satisfies LineageView;
const propose = { type: 'marriage.propose', targetGeneralId: 12 } as const;

it('T4-95 AC-P2-32 세부 칸이 없는 인물은 나이·도시·직책·초상을 모름(null)으로 둔다', () => {
  const unknown = [personAge(hidden), personCity(view, hidden), personOffice(hidden), personPortrait(hidden)];
  expect(unknown).toEqual([null, null, null, null]);
  const known = [personAge(own), personCity(view, own), personOffice(own), personPortrait(own)];
  expect(known).toEqual([20, '낙양', '군주', 3]);
});

it('T4-95 AC-P2-32 isHuman이 없으면 NPC로 짐작하지 않고 두 경우 문구를 쓴다', () => {
  const rule = proposalRule(view, 12);
  expect(rule).toContain('도겸이(가) 사람 장수면 제안이 가고 직접 수락해야 혼인합니다.');
  expect(rule).toContain('NPC면');
  expect(rule).not.toContain('NPC입니다');
  expect(appliedMessage(view, propose, 'marriage.propose')).toBe(APPLIED_MESSAGE['marriage.propose']);
  // 같은 국가 NPC는 지금처럼 즉시 판정 문구를 쓴다.
  const npc = { ...view, people: [own, { ...own, id: 12, name: '도겸', isHuman: false }] };
  expect(proposalRule(npc, 12)).toBe(
    '도겸은(는) NPC입니다. 처리할 때 소속·친화 조건으로 바로 판정하고 맞으면 제안 없이 바로 혼인합니다.',
  );
  const married = '도겸(NPC)과(와) 혼인했습니다. 혼인 탭에서 확인하세요.';
  expect(appliedMessage(npc, propose, 'marriage.propose')).toBe(married);
});

it('T4-95 AC-P2-32 등장 연도는 미등장 인물의 실제 정수 연도일 때만 보인다', () => {
  const waiting = { ...own, active: false };
  expect(comingOfAgeYear(waiting)).toBe(170);
  expect(comingOfAgeYear({ ...hidden, active: false })).toBeNull();
  expect(comingOfAgeYear({ ...waiting, activeFromYear: 170.5 })).toBeNull();
  expect(comingOfAgeYear(own)).toBeNull();
});

it('T4-95 AC-P2-32 가주 도시는 제안 행의 정수 householdCityKey만 쓴다', () => {
  const offer: LineageOffer = {
    id: 5,
    fromId: 12,
    toId: 10,
    expiresTick: 30,
    householdGeneralId: 12,
    householdCityKey: 7,
  };
  expect(offerHouseholdCity(view, offer)).toBe('낙양');
  expect(offerHouseholdCity(view, { ...offer, householdCityKey: Number.NaN })).toBeNull();
});
