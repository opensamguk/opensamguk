import { cityUpgradeCommands } from './commands';
import { describe, expect, it } from 'vitest';
import { cityLandSlots, rngFor } from '@opensamguk/shared';
import { commandInitial } from '../../test/commandFixture';
import { initialReplayState } from '../replay';
import { providedRuleData } from '../providedRuleData';
import { CITY_SCALE_FIELDS, cityScaleIncrease, checkMapCityScale, resolveCityScale } from '../world/map/cityScale';
import { checkCityScaleInitial, readCityRuins } from '../cityScale/state';
import { initialCityUpgrade } from './state';
import {
  completeCityUpgrade,
  shiftedLandSlot,
  shiftCityLandTurns,
  cityUpgradeInfo,
  CITY_UPGRADE_RULES,
} from './upgrade';
import { applyEffects } from '../commands/effects';
import { cloneWorld } from '../model/clone';
import { readCityLand, cityLandInfo, buildingFailure, sumLandCity } from '../construction/land';
import { readCampaignState } from '../campaign/state';
import { unifiedNation } from '../season';
import { countyTaxDestination } from '../cityAffiliation';
import { commandAttackTargets } from '../commandPaths';
import { settleDisaster } from '../monthly/disaster';
import { executeStratagem } from '../commands/ext/stratagem/base';
import { resolverForRuleFeatures } from '../ruleCommands';
import { consumeCityGoods } from '../logistics/consumption';
import { runGeneralTurn } from '../commands/turn';
import { runReplayAction } from '../replay';
import { applyNationTurnsRecord } from '../personnel/inputs';
import { canApproveProposal } from '../personnel/proposals';
import { settleSupply } from '../monthly/index';

const actor = { generalId: 1, tick: 0 };
function setup(level = 2) {
  const initial = commandInitial();
  const base = initial.cities[0]!;
  initial.cities = [2, 5, 6, 7, 8].map((level, index) => ({
    ...structuredClone(base),
    cityKey: index + 1,
    kind: 'CITY' as const,
    level,
    name: `도시${index + 1}`,
    nationId: index === 0 ? 1 : 2,
    x: index,
    connections: [1, 2, 3, 4, 5].filter((key) => key !== index + 1),
    state: 0,
    parentCityKey: null,
    ...Object.fromEntries(
      CITY_SCALE_FIELDS.flatMap((field) => [
        [field, 100],
        [`${field}Max`, (index + 1) * 1000],
      ]),
    ),
  }));
  initial.cities[0]!.level = level;
  const replay = initialReplayState(initial);
  const state = replay.state;
  state.cities[1]!.level = level;
  state.cities[1]!.population = 100000;
  state.cities[1]!.populationMax = 200000;
  state.cities[1]!.supplied = true;
  state.nations[1]!.gold = 1000000;
  state.campaign!.land = {
    version: 1,
    managed: {},
    cities: {
      '1': cityLandSlots('CITY', level).map((slot) => ({
        slotId: slot.id,
        building: slot.zone === 'inside' ? ('market' as const) : ('farm' as const),
        remainingTurns: 0,
        score: 10,
      })),
    },
  };
  state.cityResources!.cities['1'] = { gold: 100000, rice: 100000, garrison: [] };
  state.generals[1]!.officerLevel = 12;
  state.generals[1]!.userId = 'int30-user';
  replay.residenceAnchors = { ...replay.residenceAnchors, 1: 0 };
  state.generals[1]!.nationId = 1;
  state.generals[1]!.cityKey = 1;
  return replay;
}
const expand = cityUpgradeCommands[0]!,
  shrink = cityUpgradeCommands[1]!;
function execute(state: ReturnType<typeof setup>['state'], key = 'nation_expand', cityKey = 1) {
  const result = resolverForRuleFeatures(state)!.run(
    state,
    { ...actor, target: 'nation', authority: 'office' },
    key,
    { cityKey },
    rngFor('resize'),
  );
  if ('code' in result) throw Error(result.message);
  return { state: applyEffects(state, result.effects), result };
}
function finish(state: ReturnType<typeof setup>['state'], key = 'nation_expand') {
  for (let turn = 0; turn < CITY_UPGRADE_RULES.turns; turn++) state = execute(state, key).state;
  return state;
}
const steps = [
  [2, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
] as const;
describe('AC-INT-30 D-109 국가 증축·감축', () => {
  it.each(['move', 'return', 'return_border', 'attack', 'join', 'join_random', 'accept_invite'])(
    '%s 뒤의 예턴 좌표는 보존한다',
    (commandKey) => {
      const queue = [
        { commandKey: 'build', args: { slotId: '0,0' } },
        { commandKey, args: {} },
        { commandKey: 'build', args: { slotId: '0,0' } },
      ];
      shiftCityLandTurns(queue, { cityKey: 1, fromLevel: 2, nextLevel: 5 });
      expect(queue[0]!.args).toEqual({ slotId: '0.5,0.5' });
      expect(queue[2]!.args).toEqual({ slotId: '0,0' });
    },
  );
  it('감축으로 완공 주거가 철거되면 인구를 줄어든 최대치에 맞춘다', () => {
    const { state } = setup(2);
    state.cities[1]!.populationMax = 50000;
    completeCityUpgrade(state, 1, 5);
    state.campaign!.land!.cities['1'] = [{ slotId: '-2.5,-2.5', building: 'house', remainingTurns: 0, score: 0 }];
    state.cities[1]!.populationMax += 1000;
    state.cities[1]!.population = 151000;
    completeCityUpgrade(state, 1, 2);
    expect(state.cities[1]!.populationMax).toBe(50000);
    expect(state.cities[1]!.population).toBe(50000);
  });
  it.each([
    ['nation_expand', 'nation_expand'],
    ['nation_expand', 'nation_shrink'],
    ['nation_shrink', 'nation_expand'],
    ['nation_shrink', 'nation_shrink'],
  ])('다른 직책의 %s 준비 중 %s이 먼저 완료되면 실패하고 준비를 지운다', (key, otherKey) => {
    let { state } = setup(5);
    completeCityUpgrade(state, 1, 6);
    for (let i = 0; i < 4; i++) state = execute(state, key).state;
    expect(state.preparedTurns!.nations[1]![12]).toMatchObject({ cityLevel: 6, term: 4 });
    state.generals[2]!.nationId = 1;
    state.generals[2]!.officerLevel = 11;
    const resolver = resolverForRuleFeatures(state)!;
    for (let i = 0; i < 5; i++) {
      const result = resolver.run(
        state,
        { generalId: 2, target: 'nation', authority: 'office' },
        otherKey,
        { cityKey: 1 },
        rngFor('other'),
      );
      if ('code' in result) throw Error(result.message);
      state = applyEffects(state, result.effects);
      if (i === 0) expect(cityUpgradeInfo(state, 1, actor).preparing).toHaveLength(2);
    }
    const before = cloneWorld(state);
    state.officeTurns = { 1: { 12: Array.from({ length: 12 }, () => ({ commandKey: key, args: { cityKey: 1 } })) } };
    const outcome = runGeneralTurn(
      state,
      actor,
      { commandKey: 'rest', args: {}, explicit: true },
      'conflict',
      {},
      resolver,
      { offices: { 1: { 12: { revision: 0, tenure: 0 } } } },
    );
    expect(outcome.nation!.result).toMatchObject({
      code: 'BAD_STATE',
      message: '준비하는 동안 이 도시 규모가 바뀌었습니다.',
    });
    expect(outcome.state.preparedTurns!.nations).toEqual({});
    expect(outcome.state.cities).toEqual(before.cities);
    expect(outcome.state.nations).toEqual(before.nations);
    expect(outcome.state.campaign).toEqual(before.campaign);
  });
  it.each(steps)('%s→%s는 모든 건물·공사와 현재값을 보존하고 고정폭 상한을 더한다', (from, to) => {
    const { state } = setup(from),
      before = cloneWorld(state);
    state.campaign!.land!.cities['1']![0]!.remainingTurns = 1;
    state.campaign!.land!.cities['1']![0]!.score = 0;
    completeCityUpgrade(state, 1, to);
    expect(readCityLand(state).cities['1']).toHaveLength(cityLandSlots('CITY', from).length);
    expect(state.campaign!.land!.cities['1']![0]!.remainingTurns).toBe(1);
    for (const slot of cityLandSlots('CITY', from)) {
      const shifted = cityLandSlots('CITY', to).find((row) => row.id === shiftedLandSlot(slot.id, from, to));
      expect(shifted).toBeDefined();
      if (slot.zone === 'inside') expect(shifted!.zone).toBe('inside');
    }
    for (const field of CITY_SCALE_FIELDS) {
      expect(state.cities[1]![field]).toBe(before.cities[1]![field]);
      expect(state.cities[1]![`${field}Max`]).toBe(
        before.cities[1]![`${field}Max`] + CITY_UPGRADE_RULES.increase[field],
      );
    }
    expect(readCampaignState(JSON.parse(JSON.stringify(state.campaign)), state)).toEqual(state.campaign);
  });
  it.each(steps)('%s←%s 감축은 역이동하고 사라진 칸의 건물·공사만 환급 없이 철거한다', (original, from) => {
    const { state } = setup(original);
    completeCityUpgrade(state, 1, from);
    const slots = cityLandSlots('CITY', from);
    state.campaign!.land!.cities['1'] = slots.map((slot, index) => ({
      slotId: slot.id,
      building: slot.zone === 'inside' ? 'market' : 'farm',
      remainingTurns: index === 0 ? 2 : 0,
      score: index === 0 ? 0 : 10,
    }));
    const before = cloneWorld(state),
      info = cityUpgradeInfo(state, 1, actor);
    const after = finish(state, 'nation_shrink');
    expect(after.cities[1]!.level).toBe(original);
    const surviving = before.campaign!.land!.cities['1']!.filter(
      (row) => !info.shrink.demolished.some((removed) => removed.slotId === row.slotId),
    );
    expect(readCityLand(after).cities['1']).toEqual(
      surviving.map((row) => ({ ...row, slotId: shiftedLandSlot(row.slotId, from, original) })),
    );
    expect(info.shrink.demolished).toContainEqual({ slotId: slots[0]!.id, building: 'farm' });
    expect(after.nations[1]!.gold).toBe(before.nations[1]!.gold + CITY_UPGRADE_RULES.refund);
    expect(after.generals[1]!.gold).toBe(before.generals[1]!.gold);
    expect(after.cityResources).toEqual(before.cityResources);
    expect(after.cities[1]!.population).toBe(30000);
    for (const field of CITY_SCALE_FIELDS)
      expect(after.cities[1]![`${field}Max`]).toBe(
        before.cities[1]![`${field}Max`] - CITY_UPGRADE_RULES.increase[field],
      );
    expect(shrink.check(after, actor, { cityKey: 1 })?.code).toBe('BAD_TARGET');
    expect(readCampaignState(after.campaign, after)).toEqual(after.campaign);
  });
  it.each(steps)('%s→%s는 연속 다섯 칸째 국고 금만 한 번 내고 완료한다', (from, to) => {
    let { state } = setup(from);
    const before = cloneWorld(state);
    for (let turn = 1; turn <= 5; turn++) {
      state = execute(state).state;
      expect(state.cities[1]!.level).toBe(turn < 5 ? from : to);
      expect(state.nations[1]!.gold).toBe(before.nations[1]!.gold - (turn < 5 ? 0 : CITY_UPGRADE_RULES.cost));
      expect(state.nations[1]!.rice).toBe(before.nations[1]!.rice);
      expect(state.cityResources).toEqual(before.cityResources);
      if (turn < 5)
        expect(cityLandInfo(state, 1, actor).upgrade.preparing).toEqual([
          { commandKey: 'nation_expand', officerLevel: 12, remainingTurns: 5 - turn },
        ]);
      else expect(state.preparedTurns!.nations).toEqual({});
    }
  });
  it('도시·명령이 바뀌면 처음부터 준비하고 다른 성공 명령이면 준비를 지운다', () => {
    let { state } = setup();
    state.cities[2]!.nationId = 1;
    state.cities[2]!.supplied = true;
    state = execute(execute(state).state).state;
    state = execute(state, 'nation_expand', 2).state;
    expect(state.preparedTurns!.nations[1]![12]!.term).toBe(1);
    state = execute(state).state;
    expect(state.preparedTurns!.nations[1]![12]!.term).toBe(1);
    const other = runGeneralTurn(
      state,
      actor,
      { commandKey: 'rest', args: {}, explicit: true },
      'rest',
      {},
      resolverForRuleFeatures(state),
      { offices: { 1: { 12: { revision: 0, tenure: 0 } } } },
    );
    // 직책 예턴의 휴식이 이어지면 기존 준비가 해제된다.
    expect(other.state.preparedTurns!.nations).toEqual({});
  });
  it.each([0, 1, 4, 5, 10, 11, 12, 13, 5.5])('수뇌 권한 %s를 실행 전에 검사한다', (level) => {
    const { state } = setup();
    state.generals[1]!.officerLevel = level;
    expect(expand.check(state, actor, { cityKey: 1 })?.code ?? null).toBe(
      Number.isInteger(level) && level >= 5 && level <= 12 ? null : 'NOT_RULER',
    );
  });
  it('보급·소유·금·기능 끄기를 검사하고 태수·도시 자원 조건은 쓰지 않는다', () => {
    const { state } = setup();
    state.campaign!.land!.cities['1'] = [];
    state.cities[1]!.population = 0;
    state.cityResources!.cities['1']!.gold = 0;
    state.cityResources!.cities['1']!.rice = 0;
    expect(expand.check(state, actor, { cityKey: 1 })).toBeNull();
    state.nations[1]!.gold = CITY_UPGRADE_RULES.cost - 1;
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe('NO_GOLD');
    state.nations[1]!.gold = CITY_UPGRADE_RULES.cost;
    expect(expand.check(state, actor, { cityKey: 1 })).toBeNull();
    state.cities[1]!.supplied = false;
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe('NO_SUPPLY');
    state.cities[1]!.nationId = 2;
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe('NOT_OWN_CITY');
    state.campaign!.cityUpgrade!.enabled = false;
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe('COMMAND_DISABLED');
    delete state.campaign!.cityUpgrade;
    expect(readCampaignState(JSON.parse(JSON.stringify(state.campaign)), state).cityUpgrade).toBeUndefined();
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe('COMMAND_DISABLED');
    const data = providedRuleData(commandInitial(), 60);
    delete data['city-upgrade-v1'];
    expect(initialReplayState(commandInitial(), data).state.campaign!.cityUpgrade).toBeUndefined();
    expect(initialCityUpgrade(commandInitial(), { version: 1, enabled: false }).enabled).toBe(false);
  });
  it.each([0, 9])('규모 %s는 증축 대상이 아니다', (level) => {
    const { state } = setup();
    state.cities[1]!.level = level;
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe(level === 9 ? 'AT_MAX' : 'BAD_TARGET');
  });
  it.each(['PASS', 'FIELD'] as const)('%s는 증축·감축 대상이 아니다', (kind) => {
    const { state } = setup();
    state.cities[1]!.kind = kind;
    expect(expand.check(state, actor, { cityKey: 1 })?.code).toBe('BAD_TARGET');
    expect(shrink.check(state, actor, { cityKey: 1 })?.code).toBe('BAD_TARGET');
  });
  it('현 1~4 모두 원래 규모까지만 되돌리고 소속을 되붙이지 않는다', () => {
    for (const level of [1, 2, 3, 4]) {
      const { state } = setup(level);
      state.cities[1]!.parentCityKey = 2;
      const others = Object.values(state.cities)
        .slice(1)
        .map((city) => city.parentCityKey);
      const after = finish(finish(state), 'nation_shrink');
      expect(after.cities[1]).toMatchObject({ level, parentCityKey: null });
      expect(
        Object.values(after.cities)
          .slice(1)
          .map((city) => city.parentCityKey),
      ).toEqual(others);
    }
  });
  it.each(steps)('%s↔%s 예턴은 첫 이동 전 건설·철거만 역이동한다', (from, to) => {
    const slotId = cityLandSlots('CITY', from).find((slot) => slot.zone === 'inside')!.id;
    const queue = [
      { commandKey: 'build', args: { slotId } },
      { commandKey: 'move', args: { cityKey: 2 } },
      { commandKey: 'demolish', args: { slotId: '0,0' } },
    ];
    shiftCityLandTurns(queue, { cityKey: 1, fromLevel: from, nextLevel: to });
    expect(queue[0]!.args.slotId).toBe(shiftedLandSlot(slotId, from, to));
    expect(queue[2]!.args.slotId).toBe('0,0');
    shiftCityLandTurns(queue, { cityKey: 1, fromLevel: to, nextLevel: from });
    expect(queue[0]!.args.slotId).toBe(slotId);
  });
  it.each(['move', 'return', 'return_border', 'attack', 'join', 'join_random', 'accept_invite'])(
    '실제 재생에서 국가 명령 직후 건설을 옮기고 %s 뒤 예턴은 보존한다',
    (barrier) => {
      const replay = setup();
      replay.state.preparedTurns!.nations = {
        1: { 12: { commandKey: 'nation_expand', args: { cityKey: 1 }, term: 4 } },
      };
      replay.state.officeTurns = {
        1: { 12: Array.from({ length: 12 }, () => ({ commandKey: 'nation_expand', args: { cityKey: 1 } })) },
      };
      replay.state.generals[1]!.nextTurnTick = 0;
      for (const general of Object.values(replay.state.generals)) if (general.id !== 1) general.nextTurnTick = 100;
      replay.state.campaign!.land!.cities['1'] = [];
      replay.state.logistics!.cities['1']!.wood = 100;
      replay.turns[1] = [{ commandKey: 'build', args: { slotId: '-1,1', building: 'farm' }, explicit: true }];
      replay.state.generals[2]!.cityKey = 1;
      replay.turns[2] = [
        { commandKey: 'demolish', args: { slotId: '0,0' } },
        { commandKey: barrier, args: { cityKey: 2 } },
        { commandKey: 'build', args: { slotId: '0,0', building: 'farm' } },
      ];
      const preview = runGeneralTurn(
        replay.state,
        actor,
        replay.turns[1]![0]!,
        'resize',
        {},
        resolverForRuleFeatures(replay.state),
        { offices: replay.offices! },
      );
      expect(preview.result).not.toHaveProperty('code');
      const after = runReplayAction(replay, 'resize');
      expect(after.state.cities[1]!.level).toBe(5);
      expect(after.state.campaign!.land!.cities['1']).toContainEqual(
        expect.objectContaining({ slotId: '-0.5,1.5', building: 'farm' }),
      );
      expect(after.turns[2]![0]!.args).toEqual({ slotId: '0.5,0.5' });
      expect(after.turns[2]![2]).toEqual(replay.turns[2]![2]);
      expect(after.revisions[1]).toBe(replay.revisions[1]! + 2);
      expect(after.revisions[2]).toBe(replay.revisions[2]! + 1);
    },
  );
  it('인사 예약 입력과 제안 권한도 새 국가 명령을 허용하고 잘못된 인자를 거부한다', () => {
    const { state } = setup();
    const record = {
      generalId: 1,
      kind: 'nationTurns.set',
      status: 'APPLIED',
      sequence: 1,
      payload: {
        office: { nationId: 1, officerLevel: 12, tenure: 0 },
        revision: 0,
        turns: Array.from({ length: 12 }, (_, slot) => ({
          commandKey: slot < 5 ? 'nation_expand' : 'nation_rest',
          args: slot < 5 ? { cityKey: 1 } : {},
        })),
      },
      result: { revision: 1 },
    };
    expect(() =>
      applyNationTurnsRecord(state, { 1: { 12: { revision: 0, tenure: 0 } } }, record as never),
    ).not.toThrow();
    expect(canApproveProposal(state, 5, 'nation_shrink')).toBe(true);
    const resolver = resolverForRuleFeatures(state)!;
    expect(
      resolver.run(state, { ...actor, target: 'nation' }, 'nation_expand', { cityKey: '1' }, rngFor('bad')),
    ).toMatchObject({ code: 'BAD_ARGS' });
    expect(resolver.get('upgrade_city')).toBeUndefined();
  });
  it('수도가 아닌 자기 도시도 증축하며 도시·장수 자원을 쓰지 않는다', () => {
    let { state } = setup();
    state.cities[2]!.nationId = 1;
    state.cities[2]!.supplied = true;
    const before = cloneWorld(state);
    for (let i = 0; i < 5; i++) state = execute(state, 'nation_expand', 2).state;
    expect(state.cities[2]!.level).toBe(6);
    expect(state.nations[1]!.capitalCityKey).toBe(1);
    expect(state.cityResources).toEqual(before.cityResources);
    expect(state.generals).toEqual(before.generals);
  });
  it('감축으로 사라진 칸의 건설·철거 예턴은 실행할 때 실패한다', () => {
    let { state } = setup();
    state = finish(state);
    state.campaign!.land!.cities['1']!.push({ slotId: '-2.5,-2.5', building: 'farm', remainingTurns: 1, score: 0 });
    const queue = [
      { commandKey: 'demolish', args: { slotId: '-2.5,-2.5' } },
      { commandKey: 'build', args: { slotId: '-2.5,-2.5', building: 'farm' } },
    ];
    const preview = cityUpgradeInfo(state, 1, actor).shrink.demolished;
    expect(preview).toContainEqual({ slotId: '-2.5,-2.5', building: 'farm' });
    state = finish(state, 'nation_shrink');
    shiftCityLandTurns(queue, { cityKey: 1, fromLevel: 5, nextLevel: 2 });
    for (const turn of queue)
      expect(
        resolverForRuleFeatures(state)!.run(state, actor, turn.commandKey, turn.args, rngFor('removed')),
      ).toMatchObject({ code: 'BAD_TARGET' });
  });
  it('시설 합산 뒤에도 증축 고정폭을 유지하고 감축 감소량을 되살리지 않는다', () => {
    const { state } = setup();
    state.campaign!.land!.managed['1'] = ['commerce'];
    sumLandCity(state, 1);
    const max = state.cities[1]!.commerceMax;
    completeCityUpgrade(state, 1, 5);
    sumLandCity(state, 1);
    expect(state.cities[1]!.commerceMax).toBe(max + 2000);
    completeCityUpgrade(state, 1, 2);
    const current = state.cities[1]!.commerce;
    sumLandCity(state, 1);
    expect(state.cities[1]!.commerce).toBe(current);
  });
  it('경 승격은 저장되지만 처음 지도의 경 제한은 유지한다', () => {
    const { state } = setup(8);
    completeCityUpgrade(state, 1, 9);
    expect(readCampaignState(state.campaign, state)).toBeDefined();
    expect(readCityRuins(state.cityRuins, state, { cities: [] })).toBeDefined();
    const max = Object.fromEntries(CITY_SCALE_FIELDS.map((field) => [field, 1000])) as ReturnType<
      typeof cityScaleIncrease
    >;
    expect(() => checkMapCityScale({ id: 1, name: '도시1', level: 9, max, initial: max } as never)).toThrow('낙양');
    const initial = commandInitial();
    initial.cities[0]!.level = 9;
    initial.cityScale = { cities: [{ cityKey: 1, level: 9, max }] };
    expect(() => checkCityScaleInitial(initial)).toThrow('낙양');
  });
  it('원래 지도 경 계산은 평균 차이의 반올림을 유지한다', () => {
    const sample = [7, 7, 8, 8].map((level, index) => ({
      id: index + 1,
      name: index === 2 ? '낙양' : `표본${index}`,
      region: 1,
      position: { x: index, y: 0 },
      connections: [],
      level,
      max: Object.fromEntries(CITY_SCALE_FIELDS.map((field) => [field, [100, 101, 201, 203][index]!])) as ReturnType<
        typeof cityScaleIncrease
      >,
      initial: Object.fromEntries(CITY_SCALE_FIELDS.map((field) => [field, 10])) as ReturnType<
        typeof cityScaleIncrease
      >,
    }));
    const increase = cityScaleIncrease(sample, 8, 9);
    expect(increase.population).toBe(102);
    expect(resolveCityScale(sample, [{ city: '낙양', level: 9 }]).cities[2]!.max.population).toBe(303);
  });
  it('완전히 복구된 폐허의 승격 최대치를 생성 원장과 대조한다', () => {
    const { state } = setup();
    const max = Object.fromEntries(
      CITY_SCALE_FIELDS.map((field) => [field, state.cities[1]![`${field}Max`]]),
    ) as ReturnType<typeof cityScaleIncrease>;
    completeCityUpgrade(state, 1, 5);
    expect(
      readCityRuins(state.cityRuins, state, { cities: [{ cityKey: 1, level: 2, max, ruin: true }] }),
    ).toBeDefined();
  });
  it('통일·부속 현·경로·약탈·보급·재해·대시장은 새 등급을 따른다', () => {
    const { state } = setup();
    for (const city of Object.values(state.cities)) city.nationId = city.cityKey === 1 ? 2 : 1;
    state.cities[1]!.parentCityKey = 2;
    state.cities[2]!.connections = [3];
    state.cities[3]!.connections = [2, 1];
    state.cities[1]!.connections = [3];
    state.cities[3]!.x = 0.25;
    state.cities[3]!.level = 2;
    state.cities[3]!.parentCityKey = 1;
    state.cities[3]!.nationId = 2;
    state.generals[1]!.cityKey = 2;
    state.generals[1]!.nationId = 1;
    expect(unifiedNation(state)).toBe(1);
    expect(commandAttackTargets(state, 1).some((row) => row.cityKey === 1)).toBe(false);
    completeCityUpgrade(state, 1, 5);
    expect(unifiedNation(state)).toBeNull();
    expect(state.cities[1]!.parentCityKey).toBeNull();
    expect(state.cities[3]!.parentCityKey).toBe(1);
    expect(countyTaxDestination(state, 3)).toBe(1);
    expect(commandAttackTargets(state, 1).find((row) => row.cityKey === 1)?.sweptCounties).toEqual([3]);
    state.nations[1]!.capitalCityKey = 2;
    state.nations[2]!.capitalCityKey = 1;
    state.cities[2]!.supplied = true;
    const native = cloneWorld(state);
    delete native.campaign!.cityUpgrade;
    delete native.campaign!.land;
    state.campaign!.land = { version: 1, cities: {}, managed: {} };
    for (let seed = 0; seed < 15; seed++) {
      const a = cloneWorld(state),
        b = cloneWorld(native);
      expect(settleDisaster(a, { year: 200, month: 4 }, rngFor(String(seed)))).toEqual(
        settleDisaster(b, { year: 200, month: 4 }, rngFor(String(seed))),
      );
      expect(a.cities).toEqual(b.cities);
    }
    const plunder = { key: 'plunder', name: '약탈', stat: 'strength' as const };
    expect(executeStratagem(plunder, state, actor, { cityKey: 1 }, rngFor('plunder'))).toEqual(
      executeStratagem(plunder, native, actor, { cityKey: 1 }, rngFor('plunder')),
    );
    Object.assign(state.logistics!.cities['1']!, { iron: 100, wood: 100, horses: 100 });
    Object.assign(native.logistics!.cities['1']!, { iron: 100, wood: 100, horses: 100 });
    const spent = consumeCityGoods(state, 1, { iron: 10, wood: 20, horses: 30 });
    expect(spent).toEqual(consumeCityGoods(native, 1, { iron: 10, wood: 20, horses: 30 }));
    expect(spent.ok && spent.logistics.cities['1']).toMatchObject({ iron: 90, wood: 80, horses: 70 });
    expect(settleSupply(state).cities).toEqual(settleSupply(native).cities);
    const empty = cityLandSlots('CITY', 7).find((slot) => slot.zone === 'inside')!;
    completeCityUpgrade(state, 1, 6);
    completeCityUpgrade(state, 1, 7);
    state.campaign!.land!.cities['1'] = [];
    expect(buildingFailure(state, 1, empty.id, 'grand_market')).toBeNull();
  });
});
