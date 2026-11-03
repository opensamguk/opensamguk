import { expect, it } from 'vitest';
import { lineageFixture } from './testFixture';
import { decideLineageAction } from './actions';
import { lineageView } from './visibility';
import { emptyLineagePerson } from './state';

it('AC-P2-32 공개 가계에는 지갑·몰년·후계 지정을 섞지 않고 제안은 현재 당사자만 본다', () => {
  const world = lineageFixture(),
    [a, b, c] = Object.keys(world.generals).map(Number);
  world.generals[a!]!.userId = 'family-a';
  world.generals[b!]!.userId = 'family-b';
  world.generals[c!]!.userId = 'family-c';
  const proposed = decideLineageAction(world, a!, { type: 'marriage.propose', targetGeneralId: b! }, 0);
  if (!proposed.ok) throw Error(proposed.message);
  const before = structuredClone(proposed.world),
    publicView = lineageView(proposed.world, null, 0, a!);
  expect(publicView.mine).toBeNull();
  for (const person of publicView.people)
    for (const field of ['gold', 'rice', 'deathYear', 'heirId', 'userId'])
      expect(Object.hasOwn(person, field)).toBe(false);
  expect(lineageView(proposed.world, a!, 0).mine?.offers).toHaveLength(1);
  expect(lineageView(proposed.world, b!, 0).mine?.offers).toHaveLength(1);
  expect(lineageView(proposed.world, c!, 0).mine?.offers).toHaveLength(0);
  expect(proposed.world).toEqual(before);
});
it('AC-P2-32 조회 후보의 NPC 거부 사유는 실제 혼인 접수 규칙과 같다', () => {
  const world = lineageFixture(),
    [a, b] = Object.keys(world.generals).map(Number);
  world.generals[a!]!.userId = 'family-a';
  world.generals[b!]!.userId = null;
  const view = lineageView(world, a!, 0, undefined, () => true),
    candidate = view.mine!.marriageCandidates.find((row) => row.generalId === b)!;
  const outcome = decideLineageAction(world, a!, { type: 'marriage.propose', targetGeneralId: b! }, 0);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw Error('다른 국가 NPC의 혼인이 허용됐습니다.');
  expect(candidate.failure).toMatchObject({ code: outcome.code, message: outcome.message });
  const hidden = lineageView(world, a!, 0).mine!.marriageCandidates.find((row) => row.generalId === b)!;
  expect(hidden.failure).toMatchObject({ code: 'UNAVAILABLE' });
  expect(JSON.stringify(hidden)).not.toMatch(/NPC_REFUSED|NPC|AGE|HEIR_RESERVED/);
});
it('AC-P2-32 상세를 볼 수 있는 자녀도 다른 사람의 후계 예약 사유를 공개하지 않는다', () => {
  const world = lineageFixture(),
    [a, b, c] = Object.keys(world.generals).map(Number);
  world.generals[a!]!.userId = 'family-a';
  world.generals[b!]!.userId = 'family-b';
  world.generals[b!]!.nationId = world.generals[a!]!.nationId;
  world.generals[c!]!.nationId = world.generals[a!]!.nationId;
  world.generals[c!]!.userId = null;
  world.lineage!.persons[String(c)] = { ...emptyLineagePerson(), parents: [a!, b!] };
  world.lineage!.persons[String(b)] = { ...emptyLineagePerson(), heirId: c! };
  const decision = decideLineageAction(world, a!, { type: 'heir.designate', heirGeneralId: c! }, 0);
  expect(decision).toMatchObject({ ok: false, reason: 'HEIR_RESERVED' });
  const candidate = lineageView(world, a!, 0, undefined, () => true).mine!.heirCandidates.find(
    (row) => row.generalId === c,
  )!;
  expect(candidate.failure).toMatchObject({ code: 'UNAVAILABLE' });
  expect(JSON.stringify(candidate)).not.toContain('HEIR_RESERVED');
});
