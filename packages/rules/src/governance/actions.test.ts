import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../personnel/testFixture';
import type { WorldView } from '../model/world';
import { decideGovernanceAction, type GovernanceInput } from './actions';
import { governanceFixture, vassal } from './testFixture';

function apply(world: WorldView, actorId: number, input: GovernanceInput, tick = 1) {
  const result = decideGovernanceAction(world, actorId, input, tick);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}
function imperial() {
  const world = governanceFixture();
  world.governance!.throne = { emperorGeneralId: 1, emperorNationId: 1, sinceTick: 0 };
  world.governance!.vassals = [vassal(1, 2, 1), vassal(2, 3, 2)];
  world.governance!.nextVassalId = 3;
  return world;
}
const proposal = {
  type: 'vassal.offer',
  authority: 'OWN',
  targetNationId: 4,
  direction: 'DEMAND',
  goldBp: 500,
  riceBp: 500,
} as const;
const code = (world: WorldView, actor: number, input: unknown, tick = 1) => {
  const result = decideGovernanceAction(world, actor, input, tick);
  return result.ok ? 'OK' : result.code;
};

describe('AC-P2-31 현재 권한으로 결정하는 황실 행동', () => {
  it('한도 직전 정리가 마지막 revision을 쓰면 행동은 LIMIT로 거부한다', () => {
    const world = governanceFixture();
    world.governance!.revision = 2_147_483_646;
    world.governance!.legitimacy['99'] = 1;
    expect(code(world, 1, proposal)).toBe('LIMIT');
    expect(world.governance!.revision).toBe(2_147_483_646);
    expect(world.governance!.offers).toEqual([]);
  });
  it('정통성과 거점을 갖춘 군주의 명시 행동으로만 즉위하고 황제는 하나다', () => {
    const world = governanceFixture();
    expect(code(world, 1, { type: 'throne.ascend' })).toBe('NO_LEGITIMACY');
    world.governance!.legitimacy['1'] = 60;
    const next = apply(deepFreeze(world), 1, { type: 'throne.ascend' }).state;
    expect(next.governance!.throne).toEqual({ emperorGeneralId: 1, emperorNationId: 1, sinceTick: 1 });
    expect(world.governance!.throne.emperorGeneralId).toBeNull();
    expect(code(next, 2, { type: 'throne.ascend' })).toBe('THRONE_OCCUPIED');
    expect(code(next, 2, { type: 'throne.abdicate' })).toBe('NO_AUTHORITY');
    expect(apply(next, 1, { type: 'throne.abdicate' }).state.governance!.throne.emperorGeneralId).toBeNull();
  });
  it('거점을 잃은 국가와 봉신 국가는 정통성이 높아도 즉위하지 못한다', () => {
    const world = governanceFixture();
    world.governance!.legitimacy['1'] = 100;
    world.cities[5]!.nationId = 1;
    world.cities[1]!.nationId = 2;
    expect(code(world, 1, { type: 'throne.ascend' })).toBe('NO_SEAT');
    world.cities[1]!.nationId = 1;
    world.governance!.vassals = [vassal(1, 1, 2)];
    world.governance!.nextVassalId = 2;
    expect(code(world, 1, { type: 'throne.ascend' })).toBe('ALREADY_VASSAL');
  });
  it.each(['DEMAND', 'REQUEST'] as const)('%s는 제안만으로 관계를 바꾸지 않고 당사자 동의를 기다린다', (direction) => {
    const world = governanceFixture();
    const pending = apply(deepFreeze(world), 1, { ...proposal, direction });
    expect(pending.state.governance!.vassals).toEqual([]);
    expect(code(pending.state, 3, { type: 'vassal.respond', offerId: 1, accept: true })).toBe('NOT_PARTY');
    const accepted = apply(pending.state, 4, { type: 'vassal.respond', offerId: 1, accept: true });
    expect(accepted.state.governance!.vassals).toEqual([
      { ...vassal(1, direction === 'DEMAND' ? 4 : 1, direction === 'DEMAND' ? 1 : 4), sinceTick: 1 },
    ]);
    expect(accepted.state.governance!.offers).toEqual([]);
  });
  it('거절은 계약을 만들지 않으며 수락 뒤 경쟁 제안은 다시 판정한다', () => {
    let world = apply(governanceFixture(), 1, proposal).state;
    world = apply(world, 3, proposal).state;
    const rejected = apply(world, 4, { type: 'vassal.respond', offerId: 1, accept: false }).state;
    expect(rejected.governance!.vassals).toEqual([]);
    expect(rejected.governance!.offers.map((offer) => offer.id)).toEqual([2]);
    const accepted = apply(world, 4, { type: 'vassal.respond', offerId: 1, accept: true }).state;
    expect(code(accepted, 4, { type: 'vassal.respond', offerId: 2, accept: true })).toBe('ALREADY_VASSAL');
    expect(accepted.governance!.offers.map((offer) => offer.id)).toEqual([2]);
  });
  it('수락 전 출처 군주 교체나 새 전쟁은 옛 제안으로 우회할 수 없다', () => {
    const pending = apply(governanceFixture(), 1, proposal).state;
    pending.generals[11] = { ...pending.generals[1]!, id: 11 };
    pending.generals[1]!.officerLevel = 0;
    expect(code(pending, 4, { type: 'vassal.respond', offerId: 1, accept: true })).toBe('NOT_FOUND');
    const war = apply(governanceFixture(), 1, proposal).state;
    war.diplomacies = [{ nationA: 1, nationB: 4, state: 'DECLARED', untilTick: 20_000 }];
    expect(code(war, 4, { type: 'vassal.respond', offerId: 1, accept: true })).toBe('REALM_AT_WAR');
    expect(war.governance!.vassals).toEqual([]);
  });
  it('승상이 자국과 황제국을 구분하며 황제국 제안에는 실제 황제 서명을 남긴다', () => {
    const world = imperial();
    world.governance!.court.chancellor = { generalId: 3, appointedTick: 0 };
    const own = apply(world, 3, proposal).state.governance!.offers[0]!;
    expect(own).toMatchObject({ fromNationId: 3, sourceMonarchId: 3, actorId: 3, authority: 'OWN' });
    const delegated = apply(world, 3, { ...proposal, authority: 'EMPIRE' }).state;
    expect(delegated.governance!.offers[0]).toMatchObject({
      fromNationId: 1,
      sourceMonarchId: 1,
      actorId: 3,
      authority: 'EMPIRE',
    });
    expect(code(world, 3, { ...proposal, authority: 'EMPIRE', direction: 'REQUEST' })).toBe('NO_AUTHORITY');
    expect(code(world, 4, { ...proposal, targetNationId: 5, authority: 'EMPIRE' })).toBe('NO_AUTHORITY');
    delegated.governance!.court.chancellor = null;
    expect(code(delegated, 4, { type: 'vassal.respond', offerId: 1, accept: true })).toBe('NOT_FOUND');
  });
  it('승상은 황제국의 직접 계약만 대행하고 각 군주의 원래 해제 권한은 유지한다', () => {
    const world = imperial();
    world.generals[11] = { ...world.generals[1]!, id: 11, officerLevel: 0 };
    world.governance!.court.chancellor = { generalId: 11, appointedTick: 0 };
    expect(code(world, 11, { type: 'vassal.release', vassalId: 2 })).toBe('NO_AUTHORITY');
    const next = apply(world, 11, { type: 'vassal.release', vassalId: 1 }).state;
    expect(next.governance!.vassals.map((row) => row.id)).toEqual([2]);
    expect(next.governance!.court.chancellor?.generalId).toBe(11);
    expect(code(world, 2, { type: 'vassal.release', vassalId: 2 })).toBe('OK');
  });
  it('봉신 이탈은 즉시 전쟁 제한을 없애지 않고 월 정산을 기다린다', () => {
    const world = imperial();
    const next = apply(world, 2, { type: 'vassal.renounce', vassalId: 1 }).state;
    expect(next.governance!.vassals).toEqual(world.governance!.vassals);
    expect(next.governance!.pendingRenounce).toEqual([1]);
    expect(code(next, 2, { type: 'vassal.renounce', vassalId: 1 })).toBe('ALREADY_PENDING');
    expect(code(world, 1, { type: 'vassal.renounce', vassalId: 1 })).toBe('NOT_PARTY');
  });
  it('조정 제안은 대상 동의 뒤 직위를 주고 중복 직위는 허용하지 않는다', () => {
    const world = imperial();
    const pending = apply(world, 1, { type: 'court.offer', office: 'chancellor', generalId: 3 }).state;
    expect(pending.governance!.court.chancellor).toBeNull();
    expect(code(pending, 2, { type: 'court.respond', offerId: 1, accept: true })).toBe('NOT_PARTY');
    const accepted = apply(pending, 3, { type: 'court.respond', offerId: 1, accept: true }).state;
    expect(accepted.governance!.court.chancellor).toEqual({ generalId: 3, appointedTick: 1 });
    expect(code(accepted, 1, { type: 'court.offer', office: 'minister', generalId: 3 })).toBe('ALREADY_OFFICE');
    expect(apply(accepted, 3, { type: 'court.resign' }).state.governance!.court.chancellor).toBeNull();
    expect(
      apply(accepted, 1, { type: 'court.dismiss', office: 'chancellor' }).state.governance!.court.chancellor,
    ).toBeNull();
    expect(code(world, 1, { type: 'court.offer', office: 'minister', generalId: 4 })).toBe('BAD_TARGET');
  });
  it('사도의 면제는 황제국 직접 계약에만 닿고 상한을 지킨다', () => {
    const world = imperial();
    world.generals[11] = { ...world.generals[1]!, id: 11, officerLevel: 0 };
    world.governance!.court.minister = { generalId: 11, appointedTick: 0 };
    expect(code(world, 11, { type: 'court.remit', vassalId: 2, months: 1 })).toBe('NO_AUTHORITY');
    const next = apply(world, 11, { type: 'court.remit', vassalId: 1, months: 2 }).state;
    expect(next.governance!.vassals[0]!.remitUntilTick).toBe(20_001);
    expect(next.governance!.vassals[1]!.remitUntilTick).toBe(0);
    world.governance!.config.maxRemitMonths = 1;
    expect(code(world, 11, { type: 'court.remit', vassalId: 1, months: 2 })).toBe('BAD_ARGS');
  });
  it.each([2, 3])('국가 %i의 대행자가 자기 국가나 상위 가지를 풀어 이탈 비용·공납을 우회하지 못한다', (actor) => {
    const world = imperial();
    world.governance!.court.chancellor = { generalId: actor, appointedTick: 0 };
    expect(code(world, actor, { type: 'vassal.release', vassalId: 1 })).toBe('NO_AUTHORITY');
    world.governance!.court.chancellor = null;
    world.governance!.court.minister = { generalId: actor, appointedTick: 0 };
    expect(code(world, actor, { type: 'court.remit', vassalId: 1, months: 1 })).toBe('NO_AUTHORITY');
    expect(code(world, actor, { type: 'vassal.renounce', vassalId: actor === 2 ? 1 : 2 })).toBe('OK');
  });
  it('대장군은 계열 밖만 견책하며 tick0의 쿨다운도 지킨다', () => {
    const world = imperial();
    world.governance!.court.grandMarshal = { generalId: 3, appointedTick: 0 };
    world.governance!.legitimacy['4'] = 3;
    expect(code(world, 3, { type: 'court.censure', nationId: 2 })).toBe('BAD_TARGET');
    const next = apply(world, 3, { type: 'court.censure', nationId: 4 }, 0).state;
    expect(next.governance!.legitimacy['4']).toBe(0);
    expect(code(next, 3, { type: 'court.censure', nationId: 4 })).toBe('COOLDOWN');
    expect(code(world, 2, { type: 'court.censure', nationId: 4 })).toBe('NO_AUTHORITY');
  });
  it('임의 출처·행위자 필드, 세율·제안·tick 상한을 거부하고 원본 경제를 보존한다', () => {
    const world = deepFreeze(governanceFixture());
    expect(code(world, 1, { ...proposal, sourceNationId: 2 })).toBe('BAD_ARGS');
    expect(code(world, 1, { ...proposal, actorId: 2 })).toBe('BAD_ARGS');
    expect(code(world, 1, { ...proposal, goldBp: 2001 })).toBe('BAD_RATE');
    expect(code(world, 1, proposal, 10_000)).toBe('BAD_TICK');
    const next = apply(world, 1, proposal).state;
    const { governance: beforeGov, ...before } = world;
    const { governance: afterGov, ...after } = next;
    expect(beforeGov!.revision).toBe(0);
    expect(afterGov!.revision).toBe(1);
    expect(after).toEqual(before);
    next.governance!.config.limits.sentOffers = 1;
    expect(code(next, 1, { ...proposal, targetNationId: 5 })).toBe('LIMIT');
  });
});
