import { describe, expect, it } from 'vitest';
import { TICKS_PER_MONTH } from '../clock/constants';
import { deepFreeze } from '../personnel/testFixture';
import { assertGovernanceFinal, reconcileGovernance } from './reconcile';
import { governanceFixture, vassal } from './testFixture';
import type { GovernanceOffer } from './state';

function fixture() {
  const world = governanceFixture();
  world.governance!.throne = { emperorGeneralId: 1, emperorNationId: 1, sinceTick: 0 };
  world.governance!.vassals = [vassal(1, 2, 1), vassal(2, 3, 2)];
  world.governance!.nextVassalId = 3;
  world.governance!.court.chancellor = { generalId: 3, appointedTick: 0 };
  return world;
}
function offer(id: number, fromNationId = 1): Extract<GovernanceOffer, { kind: 'VASSAL' }> {
  return {
    id,
    kind: 'VASSAL',
    authority: 'OWN',
    fromNationId,
    sourceMonarchId: fromNationId,
    actorId: fromNationId,
    targetNationId: 4,
    direction: 'DEMAND',
    goldBp: 500,
    riceBp: 500,
    expiresTick: 6 * TICKS_PER_MONTH,
  };
}

describe('AC-P2-31 현재 군주·거점에 따른 황실 정리', () => {
  it('변화가 없으면 멱등이며 원본·금·쌀을 바꾸지 않는다', () => {
    const world = deepFreeze(fixture());
    const next = reconcileGovernance(world, 1);
    expect(next).toEqual(world);
    expect(reconcileGovernance(next, 1)).toEqual(next);
    expect(next).not.toBe(world);
  });
  it('군주 교체는 옛 서명만 지우며 같은 국가의 새 계약을 보존한다', () => {
    const world = fixture();
    world.governance!.vassals.unshift({ ...vassal(3, 2, 1), vassalMonarchId: 99 });
    world.governance!.nextVassalId = 4;
    const next = reconcileGovernance(world, 1);
    expect(next.governance!.vassals.map((row) => row.id)).toEqual([1, 2]);
    expect(next.governance!.revision).toBe(1);
    expect(reconcileGovernance(next, 1)).toEqual(next);
  });
  it('상위 군주가 교체되면 해당 계약과 소속을 벗어난 조정 직위를 정리한다', () => {
    const world = fixture();
    world.generals[2]!.officerLevel = 0;
    world.generals[22] = { ...world.generals[2]!, id: 22, officerLevel: 12 };
    world.governance!.pendingRenounce = [1, 2];
    const next = reconcileGovernance(world, 12);
    expect(next.governance!.vassals).toEqual([]);
    expect(next.governance!.pendingRenounce).toEqual([]);
    expect(next.governance!.court.chancellor).toBeNull();
    expect(next.governance!.throne.emperorGeneralId).toBe(1);
  });
  it('소재 거점 상실은 황위·조정을 비우며 옛 권한 제안을 폐기한다', () => {
    const world = fixture();
    world.cities[1]!.nationId = 5;
    world.governance!.offers = [{ ...offer(1), authority: 'EMPIRE', actorId: 3 }];
    world.governance!.nextOfferId = 2;
    const next = reconcileGovernance(world, 123);
    expect(next.governance!.throne).toEqual({ emperorGeneralId: null, emperorNationId: null, sinceTick: 123 });
    expect(Object.values(next.governance!.court)).toEqual([null, null, null]);
    expect(next.governance!.offers).toEqual([]);
    expect(next.governance!.legitimacy['1']).toBeUndefined();
    expect(world.governance!.throne.emperorGeneralId).toBe(1);
  });
  it.each(['WAR', 'DECLARED'] as const)('계열 내 %s는 가장 아래 계약을 끊고 전쟁을 보존한다', (state) => {
    const world = fixture();
    world.diplomacies = [{ nationA: 1, nationB: 3, state, untilTick: 20_000 }];
    const next = reconcileGovernance(world, 1);
    expect(next.governance!.vassals.map((row) => row.id)).toEqual([1]);
    expect(next.diplomacies).toEqual(world.diplomacies);
    expect(next.governance!.court.chancellor).toBeNull();
    expect(reconcileGovernance(next, 1)).toEqual(next);
  });
  it('기한이 지난 제안·폐지된 권한·쿨다운만 정리하고 경쟁 제안은 응답까지 보존한다', () => {
    const world = fixture();
    world.governance!.offers = [
      offer(1),
      { ...offer(2), expiresTick: 1 },
      { ...offer(3), authority: 'EMPIRE', actorId: 4 },
      { ...offer(4), targetNationId: 2 },
    ];
    world.governance!.nextOfferId = 5;
    world.governance!.censuredAt = { '1': 0, '99': 0 };
    world.governance!.npcOfferAt = { '1:4': 0, '1:99': 0 };
    const next = reconcileGovernance(world, 1);
    expect(next.governance!.offers.map((row) => row.id)).toEqual([1, 4]);
    expect(next.governance!.censuredAt).toEqual({ '1': 0 });
    expect(next.governance!.npcOfferAt).toEqual({ '1:4': 0 });
    expect(reconcileGovernance(next, 12 * TICKS_PER_MONTH).governance!.npcOfferAt).toEqual({});
  });
  it('엄격한 출력 검사는 폐지된 제안 권한과 중복 직위를 거부한다', () => {
    const world = fixture();
    world.governance!.offers = [{ ...offer(1), authority: 'EMPIRE', actorId: 4 }];
    expect(() => assertGovernanceFinal(world, 1)).toThrow('권한');
    world.governance!.offers = [];
    world.governance!.court.minister = { generalId: 3, appointedTick: 0 };
    expect(() => assertGovernanceFinal(world, 1)).toThrow('중복');
  });
  it('즉위한 본인의 기존 직위를 정리한다', () => {
    const world = fixture();
    world.governance!.court.minister = { generalId: 1, appointedTick: 0 };
    expect(reconcileGovernance(world, 1).governance!.court.minister).toBeNull();
  });
});
