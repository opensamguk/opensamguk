import { expect, it } from 'vitest';
import { decideLineageAction } from './actions';
import { emptyLineagePerson } from './state';
import { lineageFixture } from './testFixture';
import { successionPreview } from './preview';

function people() {
  const world = lineageFixture(),
    [a, b, c] = Object.keys(world.generals).map(Number);
  world.generals[a!]!.userId = 'person-a';
  world.generals[b!]!.userId = 'person-b';
  world.generals[c!]!.userId = 'person-c';
  return { world, a: a!, b: b!, c: c! };
}
it('AC-P2-32 확인 직전 후계자가 타국으로 옮기면 부적격 이유를 돌려주고 상태를 바꾸지 않는다', () => {
  const { world, a, b, c } = people();
  world.generals[b]!.userId = null;
  world.generals[b]!.nationId = world.generals[a]!.nationId;
  world.generals[b]!.cityKey = world.generals[a]!.cityKey;
  world.generals[a]!.crew = world.generals[b]!.crew = 0;
  world.generals[c]!.sex = 'FEMALE';
  world.lineage!.persons[String(b)] = { ...emptyLineagePerson(), parents: [a, c] };
  world.lineage!.persons[String(a)] = { ...emptyLineagePerson(), heirId: b };
  const preview = successionPreview(world, a, b, 0);
  if (!preview.ok) throw Error(preview.message);
  world.generals[b]!.nationId = 2;
  const before = structuredClone(world);
  expect(
    decideLineageAction(world, a, { type: 'succession.confirm', heirGeneralId: b, expected: preview.value }, 0),
  ).toMatchObject({ ok: false, code: 'HEIR_INELIGIBLE', reason: 'HEIR_NATION' });
  expect(world).toEqual(before);
});
it('AC-P2-32 사람 제안은 본인 수락 전 혼인이 아니며 역제안도 자동 수락하지 않는다', () => {
  const { world, a, b, c } = people(),
    before = structuredClone(world);
  const offered = decideLineageAction(world, a, { type: 'marriage.propose', targetGeneralId: b }, 0);
  expect(offered.ok).toBe(true);
  if (!offered.ok) throw Error(offered.message);
  expect(world).toEqual(before);
  expect(offered.world.lineage!.marriages).toEqual([]);
  const id = offered.result.offerId!;
  expect(
    decideLineageAction(offered.world, c, { type: 'marriage.respond', offerId: id, accept: true }, 0),
  ).toMatchObject({ ok: false, code: 'NOT_PARTY' });
  expect(decideLineageAction(offered.world, b, { type: 'marriage.propose', targetGeneralId: a }, 0)).toMatchObject({
    ok: false,
    code: 'OFFER_PENDING',
  });
  const accepted = decideLineageAction(offered.world, b, { type: 'marriage.respond', offerId: id, accept: true }, 0);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw Error(accepted.message);
  expect(accepted.world.lineage!.marriages).toEqual([
    { id: 1, a: Math.min(a, b), b: Math.max(a, b), householdGeneralId: a, sinceTick: 0 },
  ]);
  expect(
    decideLineageAction(accepted.world, b, { type: 'marriage.respond', offerId: id, accept: true }, 0),
  ).toMatchObject({ ok: false, code: 'OFFER_CLOSED' });
  expect([accepted.world.generals[a]!.gold, accepted.world.generals[b]!.gold]).toEqual([
    world.generals[a]!.gold,
    world.generals[b]!.gold,
  ]);
});

it('AC-P2-32 높은 ID 제안자의 가문을 유지하고 NPC의 소속·친화도 조건도 다시 검사한다', () => {
  const { world, a, b } = people();
  world.generals[b]!.userId = null;
  expect(decideLineageAction(world, a, { type: 'marriage.propose', targetGeneralId: b }, 0)).toMatchObject({
    ok: false,
    code: 'NPC_REFUSED',
  });
  world.generals[b]!.nationId = world.generals[a]!.nationId;
  const married = decideLineageAction(world, a, { type: 'marriage.propose', targetGeneralId: b }, 0);
  expect(married.ok).toBe(true);
  world.generals[b]!.userId = 'person-b';
  world.generals[a]!.userId = null;
  const higher = decideLineageAction(world, b, { type: 'marriage.propose', targetGeneralId: a }, 0);
  expect(higher.ok).toBe(true);
  if (!higher.ok) throw Error(higher.message);
  expect(higher.world.lineage!.marriages[0]!.householdGeneralId).toBe(b);
});

it('AC-P2-32 후계자의 중복 지정과 타인 조작권을 거부하며 지정 해제는 명시 입력이다', () => {
  const { world, a, b, c } = people();
  world.generals[b]!.userId = null;
  world.generals[b]!.nationId = world.generals[c]!.nationId = world.generals[a]!.nationId;
  world.generals[c]!.sex = 'FEMALE';
  world.lineage!.persons[String(b)] = { ...emptyLineagePerson(), parents: [a, c] };
  const designated = decideLineageAction(world, a, { type: 'heir.designate', heirGeneralId: b }, 0);
  expect(designated.ok).toBe(true);
  if (!designated.ok) throw Error(designated.message);
  expect(decideLineageAction(designated.world, c, { type: 'heir.designate', heirGeneralId: b }, 0)).toMatchObject({
    ok: false,
    code: 'HEIR_INELIGIBLE',
    reason: 'HEIR_RESERVED',
  });
  const cleared = decideLineageAction(designated.world, a, { type: 'heir.designate', heirGeneralId: null }, 0);
  expect(cleared.ok).toBe(true);
  if (!cleared.ok) throw Error(cleared.message);
  expect(cleared.world.lineage!.persons[String(a)]!.heirId).toBeNull();
});

it('AC-P2-32 군주 공석은 소속 사람의 명시 청구만 받으며 기존 군주를 덮어쓰지 않는다', () => {
  const { world, a, b } = people(),
    nationId = world.generals[a]!.nationId!;
  expect(decideLineageAction(world, a, { type: 'ruler.claim', nationId }, -1)).toMatchObject({
    ok: false,
    code: 'BAD_TICK',
  });
  expect(decideLineageAction(world, a, { type: 'ruler.claim', nationId }, 0)).toMatchObject({
    ok: false,
    code: 'NOT_VACANT',
  });
  world.generals[a]!.officerLevel = 0;
  expect(decideLineageAction(world, b, { type: 'ruler.claim', nationId }, 0)).toMatchObject({
    ok: false,
    code: 'NOT_MEMBER',
  });
  const claimed = decideLineageAction(world, a, { type: 'ruler.claim', nationId }, 0);
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw Error(claimed.message);
  expect(claimed.world.generals[a]!.officerLevel).toBe(12);
  expect(claimed.world.nations[nationId]!.isNpc).toBe(false);
});
