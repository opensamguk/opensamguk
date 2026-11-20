import { readCampaignState } from '../campaign/state';
import { describe, expect, it } from 'vitest';
import { rngFor, cityLandSlots } from '@opensamguk/shared';
import { commandWorld } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { cloneWorld } from '../model/clone';
import { constructionFeature } from './feature';
import { build, demolish, buildingFailure, readCityLand, cityLandInfo, facilityCapacity } from './land';
import { initialReplayState } from '../replay';
import { commandInitial } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import { resolverForRuleFeatures } from '../ruleCommands';
import { cityScaleFeature } from '../cityScale/feature';
import { CITY_SCALE_FIELDS } from '../world/map/cityScale';
const hashState = (state: unknown) => JSON.stringify(state);

const actor = { generalId: 1, tick: 0 };
function setup() {
  const state = commandWorld();
  state.logistics!.cities['1']!.wood = 1000;
  state.generals[1]!.gold = 10000;
  return state;
}
const inside = (state: ReturnType<typeof setup>) =>
  cityLandSlots(state.cities[1]!.kind, state.cities[1]!.level).find((slot) => slot.zone === 'inside')!.id;
function construct(state = setup(), building: 'market' | 'grand_market' | 'black_market' = 'market') {
  return applyEffects(state, build.execute(state, actor, { slotId: inside(state), building }, rngFor('build')).effects);
}
function settle(state: ReturnType<typeof setup>, tick = 2 * TICKS_PER_MONTH) {
  const replay = { ...initialReplayState(commandInitial()), state };
  return constructionFeature.settleMonthly!({ before: replay, settled: replay, tick }).replay.state;
}
describe('INT-28 / AC-INT-28 성 건설', () => {
  it.each([
    [9, 16, 128],
    [8, 9, 112],
    [7, 9, 72],
    [6, 4, 60],
    [5, 4, 32],
    [2, 1, 8],
  ])('규모 %s의 성 안팎 칸 수', (level, core, outer) => {
    const slots = cityLandSlots('CITY', level);
    expect(slots.filter((slot) => slot.zone === 'inside')).toHaveLength(core);
    expect(slots.filter((slot) => slot.zone === 'outside')).toHaveLength(outer);
    expect(new Set(slots.map((slot) => slot.id)).size).toBe(slots.length);
  });
  it('싸움터는 25칸이고 관문은 현 크기다', () => {
    expect(cityLandSlots('FIELD', 9)).toHaveLength(25);
    expect(cityLandSlots('FIELD', 9).every((slot) => slot.zone === 'outside')).toBe(true);
    expect(cityLandSlots('PASS', 9)).toHaveLength(9);
  });
  it('공사 시작은 금과 도시 목재를 한 번만 소비하고 복제·저장 왕복을 보존한다', () => {
    const before = setup(),
      digest = hashState(before),
      state = construct(before);
    expect(hashState(before)).toBe(digest);
    expect(state.generals[1]!.gold).toBe(9900);
    expect(state.logistics!.cities['1']!.wood).toBe(990);
    expect(readCityLand(state).cities['1']![0]).toMatchObject({ remainingTurns: 1, score: 0 });
    expect(readCityLand(JSON.parse(JSON.stringify(cloneWorld(state))))).toEqual(readCityLand(state));
    expect(build.check(state, actor, { slotId: inside(state), building: 'market' })).toMatchObject({
      code: 'BAD_TARGET',
    });
  });
  it('월 처리로 완공하고 내정 점수를 시설에 분배·합산하며 철거한다', () => {
    let state = settle(construct());
    expect(state.cities[1]!.commerce).toBe(50);
    expect(state.cities[1]!.commerceMax).toBe(100);
    state = applyEffects(state, [{ kind: 'city', id: 1, field: 'commerce', op: 'add', value: 100 }]);
    expect(state.campaign!.land!.cities['1']![0]!.score).toBe(100);
    expect(state.cities[1]!.commerce).toBe(100);
    state = applyEffects(state, demolish.execute(state, actor, { slotId: inside(state) }, rngFor('demolish')).effects);
    expect(state.cities[1]!.commerce).toBe(0);
    expect(state.cities[1]!.commerceMax).toBe(0);
    expect(state.generals[1]!.gold).toBe(9900);
  });
  it('두 턴 공사와 1월 암시장 철거를 처리한다', () => {
    const state = setup();
    state.cities[1]!.level = 7;
    const first = settle(construct(state, 'grand_market'));
    expect(first.campaign!.land!.cities['1']![0]!.remainingTurns).toBe(1);
    expect(settle(first).cities[1]!.commerce).toBe(150);
    const black = construct(setup(), 'black_market');
    expect(settle(black, TICKS_PER_MONTH).campaign!.land!.cities['1']).toEqual([]);
  });
  it('권한·자원·안팎·등급·물가·업 조건을 막고 이유를 응답한다', () => {
    const state = setup(),
      slotId = inside(state);
    state.generals[1]!.nationId = 2;
    expect(build.check(state, actor, { slotId, building: 'market' })).toMatchObject({ code: 'NOT_OWN_CITY' });
    state.generals[1]!.nationId = 1;
    state.generals[1]!.gold = 0;
    expect(build.check(state, actor, { slotId, building: 'market' })).toMatchObject({ code: 'NO_GOLD' });
    state.generals[1]!.gold = 1000;
    state.logistics!.cities['1']!.wood = 0;
    expect(build.check(state, actor, { slotId, building: 'market' })).toMatchObject({ code: 'NO_GOODS' });
    expect(buildingFailure(state, 1, slotId, 'farm')).not.toBeNull();
    expect(buildingFailure(state, 1, slotId, 'grand_market')).not.toBeNull();
    expect(buildingFailure(state, 1, slotId, 'bronze_terrace')).not.toBeNull();
    expect(
      cityLandInfo(state, 1, actor).buildings.find((spec) => spec.key === 'market')!.slots[0]!.failure,
    ).not.toBeNull();
  });
  it('공사도 단일 건물 제한에 포함하고 부정한 원장을 거부한다', () => {
    const state = setup();
    state.cities[1]!.level = 5;
    const slotId = inside(state);
    const built = applyEffects(
      state,
      build.execute(state, actor, { slotId, building: 'office' }, rngFor('office')).effects,
    );
    const another = cityLandSlots('CITY', state.cities[1]!.level).find(
      (slot) => slot.zone === 'inside' && slot.id !== slotId,
    )!;
    expect(buildingFailure(built, 1, another.id, 'office')).not.toBeNull();
    built.campaign!.land!.cities['1']!.push({ ...built.campaign!.land!.cities['1']![0]! });
    expect(() => readCityLand(built)).toThrow();
  });
  it('건설 전에는 빈 터를 조회하고 기존 상태·해시를 바꾸지 않는다', () => {
    const state = setup(),
      hash = hashState(state);
    expect(cityLandInfo(state, 1, actor).slots.every((slot) => slot.building === null)).toBe(true);
    expect(hashState(state)).toBe(hash);
    expect(hashState(settle(state))).toBe(hash);
    const resolver = resolverForRuleFeatures(state)!;
    expect(resolver.get('build')).toBeDefined();
    expect(
      resolver.precheck(state, actor, 'build', { slotId: inside(state), building: 'market', gold: 0 }),
    ).toMatchObject({ code: 'BAD_ARGS' });
  });
  it('첫 시장은 상업만 시설로 전환하고 다른 내정값을 보존한다', () => {
    const before = setup(),
      after = construct(before);
    expect(after.cities[1]!.commerce).toBe(0);
    expect(after.cities[1]!.agriculture).toBe(before.cities[1]!.agriculture);
    expect(after.cities[1]!.security).toBe(before.cities[1]!.security);
    expect(after.cities[1]!.defence).toBe(before.cities[1]!.defence);
  });
  it('직접 도시 수치 변경으로 받은 손상은 복제와 다음 월 처리 뒤에도 복구되지 않는다', () => {
    const state = settle(construct());
    state.cities[1]!.commerce = 25;
    expect(cloneWorld(state).campaign!.land!.cities['1']![0]!.score).toBe(25);
    expect(settle(state).cities[1]!.commerce).toBe(25);
  });
  it('이웃 시장 합병과 조폐 보정이 상한에 반영된다', () => {
    const state = setup();
    state.cities[1]!.level = 7;
    state.campaign!.land = {
      version: 1,
      cities: {
        '1': [
          { slotId: '-1,-1', building: 'market', remainingTurns: 0, score: 50 },
          { slotId: '-1,0', building: 'market', remainingTurns: 0, score: 50 },
          { slotId: '0,-1', building: 'mint', remainingTurns: 0, score: 50 },
        ],
      },
      managed: { '1': ['commerce'] },
    };
    expect(facilityCapacity(state, 1, '-1,-1', 'market')).toBe(180);
  });
  it('민가 완공과 철거는 인구 상한을 정확히 한 번 바꾼다', () => {
    const before = setup(),
      slotId = inside(before);
    const working = applyEffects(
      before,
      build.execute(before, actor, { slotId, building: 'house' }, rngFor('house')).effects,
    );
    const finished = settle(working);
    expect(finished.cities[1]!.populationMax).toBe(before.cities[1]!.populationMax + 1000);
    expect(settle(finished).cities[1]!.populationMax).toBe(finished.cities[1]!.populationMax);
    const removed = applyEffects(
      finished,
      demolish.execute(finished, actor, { slotId }, rngFor('remove-house')).effects,
    );
    expect(removed.cities[1]!.populationMax).toBe(before.cities[1]!.populationMax);
  });
  it('저장 경계에서도 자리·도시 참조가 잘못된 원장을 거부한다', () => {
    const state = construct();
    state.campaign!.land!.cities['1']![0]!.slotId = '999,999';
    expect(() => readCampaignState(state.campaign, state)).toThrow();
  });
  it('폐허 복구 뒤에도 완공 민가의 인구 상한을 보존한다', () => {
    const before = setup(),
      slotId = inside(before),
      city = before.cities[1]!;
    const baseMax = Object.fromEntries(
      CITY_SCALE_FIELDS.map((field) => [field, city[`${field}Max`] * 10]),
    ) as NonNullable<typeof before.cityRuins>['cities'][number]['baseMax'];
    before.cityRuins = { version: 1, cities: [{ cityKey: 1, level: city.level, stage: 0, baseMax }] };
    const built = applyEffects(
      before,
      build.execute(before, actor, { slotId, building: 'house' }, rngFor('ruin-house')).effects,
    );
    const state = settle(built),
      finished = state.cities[1]!;
    for (const field of ['population', 'agriculture', 'commerce'] as const)
      finished[field] = Math.ceil(finished[`${field}Max`] * 0.9);
    const replay = { ...initialReplayState(commandInitial()), state };
    const recovered = cityScaleFeature.settleMonthly!({ before: replay, settled: replay, tick: 3 * TICKS_PER_MONTH })
      .replay.state;
    expect(recovered.cities[1]!.populationMax).toBe(Math.floor(baseMax.population * 0.4) + 1000);
  });
});
