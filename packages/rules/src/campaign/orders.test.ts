import { describe, expect, it } from 'vitest';
import { createRng } from '@opensamguk/shared';
import { commandWorld, testUnits } from '../../test/commandFixture';
import { createCommandResolver } from '../commands/resolve';
import { runGeneralTurn } from '../commands/turn';
import { createCampaignCommandResolver } from './commands';
import { emptyCampaignState, readCampaignState } from './state';
import {
  applyCampaignOrder,
  campaignNpcSuperior,
  canIssueCampaignOrder,
  hasCampaignOrderAuthority,
  type CampaignOrderContext,
} from './orders';
import { campaignOrderInputSchema } from './orderTypes';
import { createCityResourceCommandResolver } from '../cityResources/commands';
import { emptyCityResourcesState } from '../cityResources/state';

const resolver = createCampaignCommandResolver(createCommandResolver(null));
const snapshot = (value: unknown) => JSON.stringify(value);
const slot = { commandKey: 'rest', args: {}, explicit: false };
function fixture() {
  const world = commandWorld();
  world.ruleFeatures = ['campaign-v1', 'five-stats', 'operational-map', 'personnel', 'policy'];
  for (const general of Object.values(world.generals))
    Object.assign(general, { politics: 60, charm: 55, crew: 0, cityKey: 1, nationId: 1, officerLevel: 1 });
  world.generals[1]!.userId = 'owner';
  world.generals[2]!.officerLevel = 12;
  world.generals[3]!.userId = 'recipient';
  world.cities[2]!.nationId = 1;
  world.campaign = emptyCampaignState(world, 'order-seed', 'order-source');
  world.campaign.links = [
    { masterId: 1, personId: 3, relation: 'STAFF' },
    { masterId: 1, personId: 4, relation: 'LIEUTENANT' },
  ];
  const context: CampaignOrderContext = {
    tick: 1,
    userId: 'owner',
    userActive: true,
    resolver,
    unitSet: testUnits,
    turns: Object.fromEntries([1, 2, 3, 4].map((id) => [id, Array.from({ length: 30 }, () => structuredClone(slot))])),
    revisions: { 1: 0, 2: 0, 3: 0, 4: 0 },
  };
  return { world, context };
}
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}
const issue = (recipientId: number, commandKey = 'rest', args = {}) => ({
  type: 'issue',
  recipientId,
  command: { commandKey, args },
  revision: 0,
});
const response = (revision = 1, accept = true) => ({
  type: 'respond',
  orderId: 1,
  accept,
  revision,
  expectedTurnRevision: 0,
  expectedFirstSlot: slot,
});

describe('AC-INT-19A 명시 동의·현재 상관·변경 없는30칸', () => {
  it('사람 지시는 PENDING이고 수신자 수락 뒤만 READY이며 원상태·30칸·소유권은 그대로다', () => {
    const f = fixture(),
      before = snapshot(f.world),
      queue = snapshot(f.context.turns);
    const issued = ok(applyCampaignOrder(f.world, issue(3), 1, f.context));
    expect(issued.state.campaign!.orders!.items[0]!.status).toBe('PENDING');
    expect(snapshot(f.world)).toBe(before);
    expect(snapshot(f.context.turns)).toBe(queue);
    expect(issued.state.campaign!.links).toEqual(f.world.campaign!.links);
    expect(applyCampaignOrder(issued.state, response(), 1, f.context)).toMatchObject({
      ok: false,
      code: 'NOT_ALLOWED',
    });
    const accepted = ok(applyCampaignOrder(issued.state, response(), 3, { ...f.context, userId: 'recipient' }));
    expect(accepted.state.campaign!.orders!.items[0]).toMatchObject({
      status: 'READY',
      turnRevision: 0,
      firstSlot: slot,
    });
    expect(snapshot(f.context.turns)).toBe(queue);
  });
  it('본인 거절은 원예약과 관계를 보존하며 다른 응답과 재수락은 거부한다', () => {
    const f = fixture(),
      issued = ok(applyCampaignOrder(f.world, issue(3), 1, f.context));
    const rejected = ok(applyCampaignOrder(issued.state, response(1, false), 3, { ...f.context, userId: 'recipient' }));
    expect(rejected.state.campaign!.orders!.items[0]!.status).toBe('REJECTED');
    expect(applyCampaignOrder(rejected.state, response(2), 3, { ...f.context, userId: 'recipient' })).toMatchObject({
      ok: false,
    });
  });
  it.each(['revision', 'firstSlot'])('수락 시 %s 변경은 READY를 만들지 않는다', (kind) => {
    const f = fixture(),
      issued = ok(applyCampaignOrder(f.world, issue(3), 1, f.context));
    const payload = {
      ...response(),
      ...(kind === 'revision' ? { expectedTurnRevision: 1 } : { expectedFirstSlot: { ...slot, explicit: true } }),
    };
    expect(applyCampaignOrder(issued.state, payload, 3, { ...f.context, userId: 'recipient' })).toMatchObject({
      ok: false,
      code: 'STALE',
    });
    expect(issued.state.campaign!.orders!.items[0]!.status).toBe('PENDING');
  });
  it.each(['inactive', 'other-user', 'stale', 'foreign', 'unrelated'])('%s 요청을 거부한다', (kind) => {
    const f = fixture();
    if (kind === 'foreign') f.world.generals[3]!.nationId = 2;
    if (kind === 'unrelated') f.world.campaign!.links = [];
    const context = {
      ...f.context,
      ...(kind === 'inactive' ? { userActive: false } : {}),
      ...(kind === 'other-user' ? { userId: 'other' } : {}),
    };
    const payload = { ...issue(3), revision: kind === 'stale' ? 1 : 0 };
    if (kind === 'foreign') f.world.campaign!.links = [];
    expect(applyCampaignOrder(f.world, payload, 1, context)).toMatchObject({ ok: false });
  });
  it('상급자는 하나만 유지하고 사람 직속이 있으면 NPC군주에게 우회 요청하지 않는다', () => {
    const f = fixture();
    expect(campaignNpcSuperior(f.world, 3)).toBeNull();
    expect(
      applyCampaignOrder(f.world, { type: 'request', revision: 0 }, 3, { ...f.context, userId: 'recipient' }),
    ).toMatchObject({ ok: false });
    expect(() =>
      readCampaignState(
        { ...f.world.campaign!, links: [...f.world.campaign!.links, { masterId: 2, personId: 3, relation: 'STAFF' }] },
        f.world,
      ),
    ).toThrow('MULTIPLE_SUPERIORS');
    expect(canIssueCampaignOrder(f.world, 2, 3)).toBe(true);
    expect(f.world.campaign!.links.filter((link) => link.personId === 3)).toHaveLength(1);
  });
  it('NPC상관 요청은 수신자 기준 기존전략을 같은 시드로 선택하고 사람·예턴을 바꾸지 않는다', () => {
    const f = fixture(),
      before = snapshot(f.world);
    const a = ok(applyCampaignOrder(f.world, { type: 'request', revision: 0 }, 1, f.context));
    const b = ok(applyCampaignOrder(f.world, { type: 'request', revision: 0 }, 1, f.context));
    expect(a).toEqual(b);
    expect(a.state.campaign!.orders!.items[0]).toMatchObject({ issuerId: 2, recipientId: 1, status: 'PENDING' });
    expect(a.state.generals[1]!.userId).toBe('owner');
    expect(snapshot(f.world)).toBe(before);
    expect(campaignOrderInputSchema.safeParse({ type: 'request', revision: 0, issuerId: 4 }).success).toBe(false);
  });
  it('국가 명령·꺼진 key·잘못된 인자와 다른 미처리 지시를 거부한다', () => {
    const f = fixture();
    for (const payload of [issue(3, 'nation_rest'), issue(3, 'unknown'), issue(3, 'move', { cityKey: 0 })])
      expect(applyCampaignOrder(f.world, payload, 1, f.context)).toMatchObject({ ok: false });
    const issued = ok(applyCampaignOrder(f.world, issue(3), 1, f.context));
    expect(applyCampaignOrder(issued.state, { ...issue(3), revision: 1 }, 1, f.context)).toMatchObject({
      ok: false,
      code: 'PENDING',
    });
  });
  it('과거 상태는 orders키를 만들지 않고 손상된 원장은 빈 목록으로 대체하지 않는다', () => {
    const f = fixture(),
      original = snapshot(f.world.campaign);
    expect(readCampaignState(f.world.campaign, f.world)).not.toHaveProperty('orders');
    expect(snapshot(f.world.campaign)).toBe(original);
    expect(() =>
      readCampaignState({ ...f.world.campaign!, orders: { version: 1, nextId: 1, items: [{}] } }, f.world),
    ).toThrow();
  });
});

describe('AC-INT-19B 실제차례 한 번 실행·현재권한·예약 펜스', () => {
  it.each(['move', 'train', 'form_unit'])('저장된 %s와 같은 key라도 다른 인자는 NPC 군사 예외를 얻지 못한다', (key) => {
    const f = fixture(),
      cityResolver = createCityResourceCommandResolver(resolver);
    f.world.ruleFeatures!.push('city-resources-v1');
    f.world.ruleFeatures!.sort();
    f.world.cityResources = emptyCityResourcesState(f.world);
    f.world.campaign!.nextUnitId = 3;
    f.world.campaign!.units = [1, 2].map((id) => ({
      id,
      ownerId: id === 1 ? 1 : 4,
      commanderId: 4,
      crewType: 1100,
      troops: 100,
      train: 30,
      atmos: 50,
    }));
    const args = key === 'move' ? { cityKey: 2 } : key === 'train' ? { unitId: 2 } : { crewType: 1100 };
    const changed = key === 'move' ? { cityKey: 1 } : key === 'train' ? { unitId: 1 } : { crewType: 1200 };
    const issued = ok(applyCampaignOrder(f.world, issue(4, key, args), 1, { ...f.context, resolver: cityResolver }));
    const actor = { generalId: 4, unitSet: testUnits, campaignOrderId: 1 },
      before = snapshot(issued.state);
    expect(hasCampaignOrderAuthority(issued.state, actor, key, args)).toBe(true);
    expect(cityResolver.precheck(issued.state, actor, key, args)).toBeNull();
    expect(hasCampaignOrderAuthority(issued.state, actor, key, changed)).toBe(false);
    expect(cityResolver.precheck(issued.state, actor, key, changed)).toMatchObject({ code: 'COMMAND_DISABLED' });
    expect(cityResolver.get(key)!.check(issued.state, actor, changed)).toMatchObject({ code: 'COMMAND_DISABLED' });
    expect(cityResolver.run(issued.state, actor, key, changed, createRng('order-args-fence'))).toMatchObject({
      code: 'COMMAND_DISABLED',
    });
    expect(snapshot(issued.state)).toBe(before);
  });
  it('새 도시 판의 빈 부곡 편성도 저장 지시일 때만 허용하며 금·쌀·병력을 만들지 않는다', () => {
    const f = fixture(),
      cityResolver = createCityResourceCommandResolver(resolver);
    f.world.ruleFeatures!.push('city-resources-v1');
    f.world.ruleFeatures!.sort();
    f.world.cityResources = emptyCityResourcesState(f.world);
    const cityHash = snapshot(f.world.cityResources);
    expect(
      cityResolver.precheck(f.world, { generalId: 4, unitSet: testUnits }, 'form_unit', { crewType: 1100 }),
    ).toMatchObject({ code: 'COMMAND_DISABLED' });
    const issued = ok(
      applyCampaignOrder(f.world, issue(4, 'form_unit', { crewType: 1100 }), 1, {
        ...f.context,
        resolver: cityResolver,
      }),
    );
    const turn = runGeneralTurn(
      issued.state,
      { generalId: 4, tick: 2, unitSet: testUnits },
      slot,
      'order-seed',
      { turnRevision: 0 },
      cityResolver,
    );
    expect(turn.state.campaign!.units).toEqual([
      { id: 1, ownerId: 4, commanderId: 4, crewType: 1100, troops: 0, train: 0, atmos: 0 },
    ]);
    expect(snapshot(turn.state.cityResources)).toBe(cityHash);
  });
  it('사람이 수락한 휴식은 기본방침 앞에서 한 번 실행되고 재실행되지 않는다', () => {
    const f = fixture(),
      issued = ok(applyCampaignOrder(f.world, issue(3), 1, f.context));
    const accepted = ok(applyCampaignOrder(issued.state, response(), 3, { ...f.context, userId: 'recipient' }));
    const first = runGeneralTurn(
      accepted.state,
      { generalId: 3, tick: 2, unitSet: testUnits },
      slot,
      'order-seed',
      { policy: 'farm', turnRevision: 0 },
      resolver,
    );
    expect(first.commandKey).toBe('rest');
    expect(first.state.campaign!.orders!.items[0]!.status).toBe('EXECUTED');
    const second = runGeneralTurn(
      first.state,
      { generalId: 3, tick: 10002, unitSet: testUnits },
      slot,
      'order-seed',
      { policy: 'farm', turnRevision: 1 },
      resolver,
    );
    expect(second.commandKey).toBe('farm');
  });
  it('NPC가 받은 휴식은 rest→AI 선택으로 대체하지 않는다', () => {
    const f = fixture(),
      issued = ok(applyCampaignOrder(f.world, issue(4), 1, f.context));
    const turn = runGeneralTurn(
      issued.state,
      { generalId: 4, tick: 2, unitSet: testUnits },
      slot,
      'order-seed',
      { turnRevision: 0 },
      resolver,
    );
    expect(turn.commandKey).toBe('rest');
    expect(turn.state.campaign!.orders!.items[0]!.status).toBe('EXECUTED');
  });
  it.each(['revision', 'slot', 'hierarchy', 'nation'])('%s 변경은 지시만 취소하고 원래 예약을 실행한다', (kind) => {
    const f = fixture(),
      issued = ok(applyCampaignOrder(f.world, issue(3), 1, f.context));
    const accepted = ok(applyCampaignOrder(issued.state, response(), 3, { ...f.context, userId: 'recipient' }));
    if (kind === 'hierarchy' || kind === 'nation') accepted.state.campaign!.links = [];
    if (kind === 'nation') accepted.state.generals[3]!.nationId = 2;
    const original = structuredClone(accepted.state);
    delete original.campaign!.orders;
    const nextSlot = kind === 'slot' ? { commandKey: 'farm', args: {}, explicit: true } : slot;
    const baseline = runGeneralTurn(
      original,
      { generalId: 3, tick: 2, unitSet: testUnits },
      nextSlot,
      'order-seed',
      { policy: 'farm', turnRevision: kind === 'revision' ? 1 : 0 },
      resolver,
    );
    const turn = runGeneralTurn(
      accepted.state,
      { generalId: 3, tick: 2, unitSet: testUnits },
      nextSlot,
      'order-seed',
      { policy: 'farm', turnRevision: kind === 'revision' ? 1 : 0 },
      resolver,
    );
    expect(turn.commandKey).toBe(baseline.commandKey);
    expect('code' in turn.result ? turn.result : turn.result.logs).toEqual(
      'code' in baseline.result ? baseline.result : baseline.result.logs,
    );
    expect(turn.state.generals).toEqual(baseline.state.generals);
    expect(turn.state.cities).toEqual(baseline.state.cities);
    expect(turn.state.nations).toEqual(baseline.state.nations);
    expect(turn.state.campaign!.orders!.items[0]!.status).toBe('CANCELLED');
  });
  it('명시NPC이동만 군사gate를 지나며 상관·사람·타소유부곡을 이동시키지 않는다', () => {
    const f = fixture();
    f.world.campaign!.nextUnitId = 2;
    f.world.campaign!.units = [
      { id: 1, ownerId: 1, commanderId: 4, crewType: 1100, troops: 100, train: 50, atmos: 50 },
    ];
    expect(resolver.precheck(f.world, { generalId: 4 }, 'move', { cityKey: 2 })).toMatchObject({
      code: 'COMMAND_DISABLED',
    });
    expect(resolver.precheck(f.world, { generalId: 4, campaignOrderId: 1 }, 'move', { cityKey: 2 })).toMatchObject({
      code: 'COMMAND_DISABLED',
    });
    const issued = ok(applyCampaignOrder(f.world, issue(4, 'move', { cityKey: 2 }), 1, f.context));
    const turn = runGeneralTurn(
      issued.state,
      { generalId: 4, tick: 2, unitSet: testUnits },
      slot,
      'order-seed',
      { turnRevision: 0 },
      resolver,
    );
    expect(turn.state.generals[4]!.cityKey).toBe(2);
    expect(turn.state.generals[1]!.cityKey).toBe(1);
    expect(turn.state.campaign!.units).toEqual(f.world.campaign!.units);
  });
  it('NPC는 자기부곡만 훈련하며 상관 소유부곡의 대리명령은 거부한다', () => {
    const f = fixture();
    f.world.campaign!.nextUnitId = 3;
    f.world.campaign!.units = [1, 2].map((id) => ({
      id,
      ownerId: id === 1 ? 1 : 4,
      commanderId: 4,
      crewType: 1100,
      troops: 100,
      train: 30,
      atmos: 50,
    }));
    expect(applyCampaignOrder(f.world, issue(4, 'train', { unitId: 1 }), 1, f.context)).toMatchObject({
      ok: false,
      code: 'BAD_TARGET',
    });
    const issued = ok(applyCampaignOrder(f.world, issue(4, 'train', { unitId: 2 }), 1, f.context));
    const turn = runGeneralTurn(
      issued.state,
      { generalId: 4, tick: 2, unitSet: testUnits },
      slot,
      'order-seed',
      { turnRevision: 0 },
      resolver,
    );
    expect(turn.state.campaign!.units[0]).toEqual(f.world.campaign!.units[0]);
    expect(turn.state.campaign!.units[1]!.train).toBeGreaterThan(30);
    expect(turn.state.campaign!.orders!.items[0]!.status).toBe('EXECUTED');
  });
  it('실행 시 비용 부족은 FAILED를 남기고 원예약을 이중 실행하지 않는다', () => {
    const f = fixture(),
      issued = ok(applyCampaignOrder(f.world, issue(3, 'farm'), 1, f.context));
    const accepted = ok(applyCampaignOrder(issued.state, response(), 3, { ...f.context, userId: 'recipient' }));
    accepted.state.generals[3]!.gold = 0;
    const turn = runGeneralTurn(
      accepted.state,
      { generalId: 3, tick: 2, unitSet: testUnits },
      slot,
      'order-seed',
      { turnRevision: 0 },
      resolver,
    );
    expect(turn.result).toMatchObject({ code: 'NO_GOLD' });
    expect(turn.state.campaign!.orders!.items[0]!.status).toBe('FAILED');
  });
});
