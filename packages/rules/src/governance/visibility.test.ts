import { describe, expect, it } from 'vitest';
import type { GovernanceMovement } from './ledger';
import { governanceFixture, vassal } from './testFixture';
import { governanceView, visibleGovernanceMovements } from './visibility';

function fixture() {
  const world = governanceFixture(6);
  world.governance!.throne = { emperorGeneralId: 1, emperorNationId: 1, sinceTick: 0 };
  world.governance!.vassals = [vassal(1, 2, 1), vassal(2, 3, 2), vassal(3, 5, 4)];
  world.governance!.nextVassalId = 4;
  world.generals[12] = { ...world.generals[2]!, id: 12, officerLevel: 0 };
  world.generals[13] = { ...world.generals[3]!, id: 13, officerLevel: 0 };
  world.governance!.court.chancellor = { generalId: 12, appointedTick: 0 };
  world.governance!.court.minister = { generalId: 13, appointedTick: 0 };
  world.governance!.offers = [
    {
      id: 1,
      kind: 'VASSAL',
      authority: 'OWN',
      fromNationId: 4,
      sourceMonarchId: 4,
      actorId: 4,
      targetNationId: 6,
      direction: 'DEMAND',
      goldBp: 500,
      riceBp: 500,
      expiresTick: 60_000,
    },
  ];
  world.governance!.nextOfferId = 2;
  return world;
}
function view(viewerId: number | null) {
  const result = governanceView(fixture(), viewerId, 1);
  if (!result.enabled) throw new Error('황실 DTO가 없습니다.');
  return result;
}
describe('AC-P2-31·35 황실 공통 DTO의 공개 범위', () => {
  it('공개 황위·직위·정통성·관계에서 제안·세율·원장 잔액을 분리한다', () => {
    const publicView = view(null);
    expect(publicView.vassals).toHaveLength(3);
    expect(publicView.vassals.every((row) => !('goldBp' in row) && !('remitUntilTick' in row))).toBe(true);
    expect(publicView.offers).toEqual([]);
    expect(publicView.court[0]!.appointment).toMatchObject({ generalId: 12 });
    expect(publicView.throne.emperorGeneralId).toBe(1);
    expect(Object.keys(publicView)).not.toContain('censuredAt');
    expect(JSON.stringify(publicView)).not.toContain('garrison');
  });
  it('군주 당사자·황제·직접 황제국 대행자만 정해진 세율을 읽는다', () => {
    const exposed = (id: number) =>
      view(id)
        .vassals.filter((row) => 'goldBp' in row)
        .map((row) => row.id);
    expect(exposed(1)).toEqual([1, 2, 3]);
    expect(exposed(2)).toEqual([1, 2]);
    expect(exposed(3)).toEqual([2]);
    expect(exposed(12)).toEqual([1]);
    expect(exposed(13)).toEqual([1]);
    expect(exposed(6)).toEqual([]);
    expect(view(1).offers).toEqual([]);
    expect(view(12).offers).toEqual([]);
    expect(view(4).offers).toHaveLength(1);
    expect(view(6).offers).toHaveLength(1);
  });
  it('현재 군주 교체로 옛 사람이 갖던 세율·제안 열람 권한을 즉시 잃는다', () => {
    const world = fixture();
    world.generals[4]!.officerLevel = 0;
    world.generals[14] = { ...world.generals[4]!, id: 14, officerLevel: 12 };
    const result = governanceView(world, 4, 1);
    if (!result.enabled) throw new Error('황실 DTO가 없습니다.');
    expect(result.offers).toEqual([]);
    expect(result.vassals.every((row) => !('goldBp' in row))).toBe(true);
    expect(result.roles.monarch).toBe(false);
  });
  it('봉록 수령자는 자기 입금만 보고 황제·대행자도 다른 계약 금액을 읽지 못한다', () => {
    const world = fixture();
    const rows: GovernanceMovement[] = [
      {
        kind: 'TRIBUTE',
        refId: 3,
        holder: 'city',
        holderId: 5,
        resource: 'gold',
        delta: -50,
        fromNationId: 5,
        toNationId: 4,
      },
      {
        kind: 'TRIBUTE',
        refId: 3,
        holder: 'city',
        holderId: 4,
        resource: 'gold',
        delta: 50,
        fromNationId: 5,
        toNationId: 4,
      },
      {
        kind: 'STIPEND',
        refId: 1,
        holder: 'city',
        holderId: 1,
        resource: 'gold',
        delta: -100,
        fromNationId: 1,
        toNationId: 2,
      },
      {
        kind: 'STIPEND',
        refId: 1,
        holder: 'general',
        holderId: 12,
        resource: 'gold',
        delta: 100,
        fromNationId: 1,
        toNationId: 2,
      },
    ];
    expect(visibleGovernanceMovements(world, 12, 1, rows)).toEqual([rows[3]]);
    expect(visibleGovernanceMovements(world, 13, 1, rows)).toEqual([]);
    expect(visibleGovernanceMovements(world, 2, 1, rows)).toEqual([]);
    expect(visibleGovernanceMovements(world, 1, 1, rows)).toEqual(rows.slice(2));
    expect(visibleGovernanceMovements(world, 4, 1, rows)).toEqual(rows.slice(0, 2));
    world.cities[5]!.nationId = 6;
    expect(visibleGovernanceMovements(world, 6, 1, rows)).toEqual([]);
    world.governance!.vassals = [];
    expect(visibleGovernanceMovements(world, 4, 1, rows)).toEqual(rows.slice(0, 2));
  });
});
