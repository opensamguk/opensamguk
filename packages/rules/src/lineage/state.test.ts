import { expect, it } from 'vitest';
import { lineageConfigSchema } from './config';
import { emptyLineagePerson, readLineageState } from './state';
import { lineageFixture, lineageTestConfig } from './testFixture';

it('AC-P2-32 공개 기본값 없이 필수 자격과 모든 수치를 받는다', () => {
  expect(lineageConfigSchema.safeParse({ version: 1 }).success).toBe(false);
  expect(lineageConfigSchema.safeParse({ ...lineageTestConfig, unknown: true }).success).toBe(false);
  expect(
    lineageConfigSchema.safeParse({ ...lineageTestConfig, marriage: { ...lineageTestConfig.marriage, minAge: 81 } })
      .success,
  ).toBe(false);
  expect(
    lineageConfigSchema.safeParse({
      ...lineageTestConfig,
      birth: { ...lineageTestConfig.birth, givenNames: ['가', '가'] },
    }).success,
  ).toBe(false);
});

it('AC-P2-32 큰 번호의 혼인 발신자도 가주로 보존하고 중복 당사자·번호를 거부한다', () => {
  const state = lineageFixture().lineage!;
  state.marriages = [{ id: 1, a: 10, b: 20, householdGeneralId: 20, sinceTick: 0 }];
  state.nextMarriageId = 2;
  expect(readLineageState(state).marriages[0]!.householdGeneralId).toBe(20);
  expect(() =>
    readLineageState({
      ...state,
      marriages: [...state.marriages, { ...state.marriages[0], id: 2 }],
      nextMarriageId: 3,
    }),
  ).toThrow();
  expect(() =>
    readLineageState({ ...state, marriages: [{ ...state.marriages[0], householdGeneralId: 30 }] }),
  ).toThrow();
  expect(() => readLineageState({ ...state, nextMarriageId: 1 })).toThrow();
});

it('AC-P2-32 혈연 자기 참조와 월 경계 역행을 거부한다', () => {
  const state = lineageFixture().lineage!;
  state.persons['10'] = { ...emptyLineagePerson(), parents: [10, 20] };
  expect(() => readLineageState(state)).toThrow();
  state.persons = {};
  expect(() => readLineageState({ ...state, monthlyTick: 1 })).toThrow();
  state.offers = [{ id: 1, fromId: 10, toId: 10, expiresTick: 10_000 }];
  state.nextOfferId = 2;
  expect(() => readLineageState(state)).toThrow();
});
