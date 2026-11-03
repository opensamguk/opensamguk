import { describe, expect, it } from 'vitest';
import { emptyCityResourcesState } from '../cityResources/state';
import { cloneWorld } from '../model/clone';
import { deepFreeze } from '../personnel/testFixture';
import { decideGovernanceAction } from './actions';
import { settleGovernanceMonthly } from './monthly';
import { governanceFixture, vassal } from './testFixture';

function fixture() {
  const world = governanceFixture();
  for (const general of Object.values(world.generals)) general.userId = `person-${general.id}`;
  for (const id of [6, 7]) world.cities[id] = { ...world.cities[1]!, cityKey: id, connections: [] };
  world.cityResources = emptyCityResourcesState(world);
  for (const city of Object.values(world.cityResources.cities)) {
    city.gold = 1000;
    city.rice = 1000;
  }
  world.governance!.legitimacy['1'] = 60;
  return world;
}
describe('AC-P2-31 공개 정보만 사용하는 NPC 황실', () => {
  it.each(['ALREADY_VASSAL', 'REALM_AT_WAR'])('첫 후보가 %s이면 다음 유효 후보에 월 한 건만 제안한다', (reason) => {
    const world = fixture();
    world.generals[1]!.userId = null;
    if (reason === 'ALREADY_VASSAL') {
      world.governance!.vassals = [vassal(1, 2, 5)];
      world.governance!.nextVassalId = 2;
    } else world.diplomacies = [{ nationA: 1, nationB: 2, state: 'DECLARED', untilTick: 20_000 }];
    const result = settleGovernanceMonthly(deepFreeze(world), 10_000);
    const proposals = result.actions.filter((action) => action.payload.type === 'vassal.offer');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.payload).toMatchObject({ type: 'vassal.offer', targetNationId: 3, direction: 'DEMAND' });
    expect(result.state.governance!.npcOfferAt['1:2']).toBeUndefined();
    expect(result.state.governance!.npcOfferAt['1:3']).toBe(10_000);
    expect(result.state.diplomacies).toEqual(world.diplomacies);
  });
  it('NPC는 조건을 채우면 즉위하지만 사람의 즉위와 계약 수락을 대신하지 않는다', () => {
    const world = fixture();
    const human = settleGovernanceMonthly(deepFreeze(world), 10_000);
    expect(human.state.governance!.throne.emperorGeneralId).toBeNull();
    expect(human.actions).toEqual([]);
    const npc = cloneWorld(world);
    npc.generals[1]!.userId = null;
    const result = settleGovernanceMonthly(deepFreeze(npc), 10_000);
    expect(result.state.governance!.throne.emperorGeneralId).toBe(1);
    expect(result.actions.map((action) => action.payload.type)).toEqual(['throne.ascend', 'vassal.offer']);
    expect(result.state.governance!.offers[0]).toMatchObject({
      fromNationId: 1,
      targetNationId: 2,
      direction: 'DEMAND',
    });
    expect(result.state.governance!.vassals).toEqual([]);
    const next = settleGovernanceMonthly(result.state, 20_000);
    expect(next.state.governance!.vassals).toEqual([]);
    expect(next.state.governance!.offers.map((offer) => offer.id)).toContain(1);
    expect(next.actions.filter((action) => action.payload.type === 'vassal.offer')).toHaveLength(1);
  });
  it.each([500, 1500])('NPC가 받는 %i bp 제안은 도시·정통성·상한으로 수락 또는 거절한다', (rate) => {
    const world = fixture();
    world.generals[4]!.userId = null;
    const pending = decideGovernanceAction(
      world,
      1,
      { type: 'vassal.offer', authority: 'OWN', targetNationId: 4, direction: 'DEMAND', goldBp: rate, riceBp: rate },
      1,
    );
    if (!pending.ok) throw new Error(pending.code);
    const result = settleGovernanceMonthly(pending.state, 10_000);
    expect(result.state.governance!.offers.some((offer) => offer.id === 1)).toBe(false);
    if (rate > 1000)
      expect(result.state.governance!.offers).toMatchObject([
        { id: 2, kind: 'VASSAL', fromNationId: 4, targetNationId: 1, direction: 'REQUEST', goldBp: 500, riceBp: 500 },
      ]);
    else expect(result.state.governance!.offers).toEqual([]);
    expect(result.state.governance!.vassals).toHaveLength(rate <= 1000 ? 1 : 0);
    expect(result.actions[0]!.payload).toEqual({ type: 'vassal.respond', offerId: 1, accept: rate <= 1000 });
  });
  it('재산과 병력을 바꿔도 제안·즉위 선택은 같고 사람이 받은 제안은 남는다', () => {
    const world = fixture();
    world.generals[1]!.userId = null;
    const rich = cloneWorld(world);
    for (const general of Object.values(rich.generals)) {
      general.gold += 100_000;
      general.crew = 5000;
    }
    for (const city of Object.values(rich.cityResources!.cities)) {
      city.gold += 1_000_000;
      city.rice += 1_000_000;
    }
    const first = settleGovernanceMonthly(deepFreeze(world), 10_000);
    const second = settleGovernanceMonthly(deepFreeze(rich), 10_000);
    expect(first.actions).toEqual(second.actions);
    expect(first.state.governance).toEqual(second.state.governance);
    expect(settleGovernanceMonthly(world, 10_000)).toEqual(first);
  });
  it('황제의 NPC 직위는 직책·id 순서로 매월 하나 제안하고 다음 월 동의·봉록을 처리한다', () => {
    let world = fixture();
    world.generals[1]!.userId = null;
    for (const id of [11, 12, 13])
      world.generals[id] = { ...world.generals[1]!, id, userId: null, officerLevel: id === 11 ? 0 : 5 };
    const first = settleGovernanceMonthly(world, 10_000);
    expect(first.state.governance!.offers).toHaveLength(1);
    expect(first.state.governance!.offers[0]).toMatchObject({
      kind: 'COURT',
      office: 'chancellor',
      targetGeneralId: 12,
    });
    expect(first.payments).toEqual([]);
    world = first.state;
    for (const tick of [20_000, 30_000, 40_000]) world = settleGovernanceMonthly(world, tick).state;
    expect(world.governance!.court).toEqual({
      chancellor: { generalId: 12, appointedTick: 20_000 },
      grandMarshal: { generalId: 13, appointedTick: 30_000 },
      minister: { generalId: 11, appointedTick: 40_000 },
    });
    expect(world.generals[12]!.gold).toBe(first.state.generals[12]!.gold + 300);
    expect(world.generals[13]!.gold).toBe(first.state.generals[13]!.gold + 200);
    expect(world.generals[11]!.gold).toBe(first.state.generals[11]!.gold + 100);
  });
});
