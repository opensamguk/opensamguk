import { expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import { settleLineageMonthly } from '../packages/rules/src/lineage/monthly';
import { lineageFixture } from '../packages/rules/src/lineage/testFixture';
import { FIVE_STAT_RULES } from '../packages/rules/src/general/fiveStats';

// Node 해시는 도구 경계에서 확인한다. 순수 rules에는 Node 의존성을 추가하지 않는다.
it('AC-P2-32·AC-INT-28 설정1의 5능력치 12개월 출생과 전체 상태 해시를 보존한다', () => {
  let world = lineageFixture();
  const [a, b] = Object.keys(world.generals).map(Number);
  world.lineage!.config.marriage.npc.perMonth = 0;
  world.lineage!.config.birth.chanceBp = 10000;
  world.lineage!.config.birth.givenNames = ['가', '나', '다', '라', '마', '바'];
  world.lineage!.config.limits.maxBirthsPerYear = 3;
  world.lineage!.marriages = [{ id: 1, a: a!, b: b!, householdGeneralId: a!, sinceTick: 0 }];
  world.lineage!.nextMarriageId = 2;
  const births: number[] = [];
  const resources = { statRules: FIVE_STAT_RULES, unitSet: { defaultCrewTypeId: 1 } };
  for (let month = 1; month <= 12; month++) {
    const result = settleLineageMonthly(world, month * 10000, resources);
    world = result.state;
    births.push(result.effects.births.length);
  }
  expect(births).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // commandFixture의 부곡 전환으로 부모의 개인 병력이 0이다. 월간 공식 계산으로 갱신한다.
  expect(hashState(world)).toMatchInlineSnapshot(`"236014bb59e942a59f5f9be22702c6f018b1e028d322e8be78a84eb4461c137a"`);
  expect(world.lineage!.config.version).toBe(1);
});
