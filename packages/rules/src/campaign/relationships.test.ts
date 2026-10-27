import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { deepFreeze } from '../personnel/testFixture';
import { applyCampaignRelationship } from './relationships';
import { emptyCampaignState, readCampaignState } from './state';
import { buildRetinueHierarchy } from './retinue';
function fixture(seed = 'campaign-relationship-test') {
  const world = commandWorld();
  world.ruleFeatures = ['five-stats'];
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1 });
  Object.assign(world.generals[1]!, { userId: 'owner', gold: 1000 });
  Object.assign(world.generals[2]!, { nationId: 1, officerLevel: 1 });
  Object.assign(world.generals[3]!, { nationId: 1, officerLevel: 1, userId: 'target' });
  const campaign = emptyCampaignState(world, seed, 'test-five-stats');
  const apply = (value: unknown, actorId = 1, tick = 0, userId = 'owner') =>
    applyCampaignRelationship(deepFreeze(world), value, actorId, deepFreeze(campaign), {
      tick,
      userId,
      userActive: true,
    });
  return { world, campaign, apply };
}
function applied<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return outcome as Extract<T, { ok: true }>;
}
const offer = (targetId: number) => ({ type: 'offer', targetId, relation: 'LIEUTENANT', revision: 0 });

describe('AC-INT-06 사람 동의와 NPC 서약의 순수 전이', () => {
  it('사람 제안은 금과 난수를 쓰지 않고 본인의 응답 전에는 관계를 만들지 않는다', () => {
    const f = fixture(),
      before = structuredClone(f.world);
    const result = applied(f.apply(offer(3)));
    expect(result.result).toEqual({ accepted: null, offerId: 1, cost: 0, chance: null, roll: null, revision: 1 });
    expect(result.campaign.links).toEqual([]);
    expect(result.state).toEqual(before);
    const accept = { type: 'respond', offerId: 1, accept: true, revision: 1 };
    expect(
      applyCampaignRelationship(result.state, accept, 1, result.campaign, {
        tick: 1,
        userId: 'owner',
        userActive: true,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_ALLOWED' });
    const accepted = applied(
      applyCampaignRelationship(result.state, accept, 3, result.campaign, {
        tick: 1,
        userId: 'target',
        userActive: true,
      }),
    );
    expect(accepted.campaign.links).toEqual([{ masterId: 1, personId: 3, relation: 'LIEUTENANT' }]);
    expect(accepted.campaign.offers[0]!.status).toBe('ACCEPTED');
    expect(accepted.state.generals[1]!.gold).toBe(before.generals[1]!.gold);
    expect(f.world).toEqual(before);
  });
  it('사람 거절은 무료이며 제안을 닫고 관계를 만들지 않는다', () => {
    const f = fixture(),
      pending = applied(f.apply(offer(3)));
    const result = applied(
      applyCampaignRelationship(
        pending.state,
        { type: 'respond', offerId: 1, accept: false, revision: 1 },
        3,
        pending.campaign,
        { tick: 1, userId: 'target', userActive: true },
      ),
    );
    expect(result.result).toMatchObject({ accepted: false, cost: 0, roll: null });
    expect(result.campaign.offers[0]!.status).toBe('REJECTED');
    expect(result.campaign.links).toEqual([]);
    expect(result.state).toEqual(f.world);
  });
  it('NPC의 같은 시드·월·행위자·대상은 같은 결과이며 유효한 거절도500금을 쓴다', () => {
    const f = Array.from({ length: 100 }, (_, n) => fixture(`refusal-${n}`)).find((candidate) => {
      const result = candidate.apply(offer(2));
      return result.ok && result.result.accepted === false;
    })!;
    expect(f).toBeDefined();
    const first = applied(f.apply(offer(2))),
      again = applied(f.apply(offer(2)));
    expect(again).toEqual(first);
    expect(first.result).toMatchObject({ accepted: false, cost: 500, chance: 52 });
    expect(first.state.generals[1]!.gold).toBe(500);
    expect(first.campaign.links).toEqual([]);
    expect(
      applyCampaignRelationship(first.state, { ...offer(2), revision: 1 }, 1, first.campaign, {
        tick: 9999,
        userId: 'owner',
        userActive: true,
      }),
    ).toMatchObject({ ok: false, code: 'ALREADY_ATTEMPTED' });
    const nextMonth = applied(
      applyCampaignRelationship(first.state, { ...offer(2), revision: 1 }, 1, first.campaign, {
        tick: 10000,
        userId: 'owner',
        userActive: true,
      }),
    );
    expect(nextMonth.state.generals[1]!.gold).toBe(0);
    expect(nextMonth.campaign.attempts).toEqual([{ masterId: 1, personId: 2, month: 1 }]);
  });
  it.each(['nation', 'position', 'ruler', 'not-appeared', 'gold', 'revision', 'owner', 'sanction'] as const)(
    '자격 실패 %s는 비용을 쓰지 않는다',
    (kind) => {
      const f = fixture();
      if (kind === 'nation') f.world.generals[2]!.nationId = 2;
      if (kind === 'position') f.world.generals[2]!.cityKey = 2;
      if (kind === 'ruler') f.world.generals[2]!.officerLevel = 12;
      if (kind === 'not-appeared') f.world.generals[2]!.activeFromYear = 192;
      if (kind === 'gold') f.world.generals[1]!.gold = 499;
      const before = structuredClone(f.world),
        campaign = structuredClone(f.campaign);
      const result = applyCampaignRelationship(
        deepFreeze(f.world),
        { ...offer(2), revision: kind === 'revision' ? 1 : 0 },
        1,
        deepFreeze(f.campaign),
        { tick: 0, userId: kind === 'owner' ? 'other' : 'owner', userActive: kind !== 'sanction' },
      );
      expect(result.ok).toBe(false);
      expect(f.world).toEqual(before);
      expect(f.campaign).toEqual(campaign);
    },
  );
  it('승낙 전에 위치가 바뀌면 오래된 제안으로 관계를 강제하지 않는다', () => {
    const f = fixture(),
      pending = applied(f.apply(offer(3)));
    pending.state.generals[3]!.cityKey = 2;
    expect(
      applyCampaignRelationship(
        pending.state,
        { type: 'respond', offerId: 1, accept: true, revision: 1 },
        3,
        pending.campaign,
        { tick: 1, userId: 'target', userActive: true },
      ),
    ).toMatchObject({ ok: false, code: 'MUST_ASSEMBLE' });
  });
  it('국가 멸망 뒤 무소속 관계를 보존하며 0·다른 국가를 같은 소속으로 보정하지 않는다', () => {
    const f = fixture();
    f.campaign.links = [{ masterId: 1, personId: 3, relation: 'STAFF' }];
    for (const general of Object.values(f.world.generals)) general.nationId = null;
    expect(readCampaignState(f.campaign, f.world).links).toEqual(f.campaign.links);
    expect(() =>
      buildRetinueHierarchy(
        [
          {
            id: 1,
            nationId: 0,
            worldId: 'world',
            stats: { leadership: 55, strength: 55, intel: 55, politics: 55, charm: 55, source: 'test' },
          },
        ],
        [],
      ),
    ).toThrow();
  });
});
