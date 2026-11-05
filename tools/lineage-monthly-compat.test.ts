import { expect, it } from 'vitest';
import { hashState } from '../packages/shared/src/node/hashState';
import { settleLineageMonthly } from '../packages/rules/src/lineage/monthly';
import { lineageFixture } from '../packages/rules/src/lineage/testFixture';

// Node 해시는 도구 경계에서 확인한다. 순수 rules에는 Node 의존성을 추가하지 않는다.
it('AC-P2-32 설정1의 12개월 출생과 변경 전 전체 상태 해시를 보존한다', () => {
  let world = lineageFixture();
  const [a, b] = Object.keys(world.generals).map(Number);
  world.lineage!.config.marriage.npc.perMonth = 0;
  world.lineage!.config.birth.chanceBp = 10000;
  world.lineage!.config.birth.givenNames = ['가', '나', '다', '라', '마', '바'];
  world.lineage!.config.limits.maxBirthsPerYear = 3;
  world.lineage!.marriages = [{ id: 1, a: a!, b: b!, householdGeneralId: a!, sinceTick: 0 }];
  world.lineage!.nextMarriageId = 2;
  const births: number[] = [];
  const resources = { statRules: { total: 180, min: 0, max: 100 }, unitSet: { defaultCrewTypeId: 1 } };
  for (let month = 1; month <= 12; month++) {
    const result = settleLineageMonthly(world, month * 10000, resources);
    world = result.state;
    births.push(result.effects.births.length);
  }
  expect(births).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(hashState(world)).toBe('d00fb76e73d1ae62ae4aaf3e609338cb2e6b9093b6df8c1e19b443fdda68bbf3');
  expect(world.lineage!.config.version).toBe(1);
});
