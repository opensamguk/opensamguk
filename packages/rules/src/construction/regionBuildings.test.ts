import { describe, expect, it } from 'vitest';
import { CASTLE_STYLES, castleStyle, cityLandSlots, rngFor } from '@opensamguk/shared';
import { commandInitial, commandWorld } from '../../test/commandFixture';
import { applyEffects } from '../commands/effects';
import { initialReplayState } from '../replay';
import { cloneWorld } from '../model/clone';
import { TICKS_PER_MONTH } from '../clock/constants';
import { cityScaleFeature } from '../cityScale/feature';
import { readCityRuins } from '../cityScale/state';
import { CITY_SCALE_FIELDS } from '../world/map/cityScale';
import { BUILDINGS, buildingSpec, type BuildingKey } from './catalog';
import { build, demolish, buildingFailure, cityLandInfo, facilityCapacity, readCityLand } from './land';
import { constructionFeature } from './feature';
import legacyBuildings from './legacyBuildings.test.json';

const actor = { generalId: 1, tick: 0 };
function setup(name = '낙양', region = 1) {
  const state = commandWorld();
  Object.assign(state.cities[1]!, { name, region, level: 9, kind: 'CITY' });
  state.generals[1]!.gold = 10000;
  state.logistics!.cities['1']!.wood = 1000;
  state.campaign!.land = { version: 1, cities: { '1': [] }, managed: { '1': [] } };
  return state;
}
type State = ReturnType<typeof setup>;
function put(state: State, building: BuildingKey, slotId: string, remainingTurns = 0) {
  state.campaign!.land!.cities['1']!.push({ building, slotId, remainingTurns, score: 0 });
}
function settle(state: State, month = 2) {
  const replay = { ...initialReplayState(commandInitial()), state };
  return constructionFeature.settleMonthly!({ before: replay, settled: replay, tick: month * TICKS_PER_MONTH }).replay
    .state;
}
function terrain(state: State, mode: 'LAND' | 'RIVER' | 'SEA', mountain = false) {
  state.campaign!.supplyLedger = {
    version: 1,
    cellSize: 16,
    routes: [
      {
        routeId: 'test',
        from: 1,
        to: 2,
        segments: [
          {
            routeId: 'test',
            mode,
            cells: [0, 1].map((x) => ({
              cellId: String(x),
              pathCellIndex: x,
              x,
              y: 0,
              mountain,
              remote: false,
              ownerAnchorKey: 1,
            })),
          },
        ],
      },
    ],
  };
}

describe('INT-29 / AC-INT-29 지역 건물, AC-INT-28 건설 회귀', () => {
  it('기존 48종의 안팎·군사·비용·시설·단일 값과 총 101종을 보존한다', () => {
    expect(BUILDINGS).toHaveLength(101);
    expect(new Set(BUILDINGS.map((spec) => spec.key)).size).toBe(101);
    for (const expected of legacyBuildings) expect(buildingSpec(expected.key as BuildingKey)).toMatchObject(expected);
    expect(
      BUILDINGS.slice(48)
        .filter((spec) => spec.military)
        .map((spec) => spec.key),
    ).toEqual(['yijing_tower', 'ruxu_dock', 'cliff_stronghold']);
  });
  const places = [
    ['낙양', 1, ['buddha_shrine', 'canal_depot', 'pond_weir']],
    ['업', 3, ['yijing_tower', 'chestnut_grove', 'canal_depot']],
    ['무위', 11, ['horse_ranch', 'salt_pool', 'border_market']],
    ['양양', 7, ['tangerine_grove', 'jing_academy']],
    ['건업', 8, ['ruxu_dock', 'celadon_kiln', 'yue_cloth']],
    ['성도', 9, ['salt_well', 'brocade_office', 'bayu_dance']],
    ['건녕', 10, ['salt_well', 'bronze_drum_altar', 'cinnabar_lacquer']],
    ['국내성', 15, ['bugyeong', 'suhyeol_altar', 'maek_bow']],
    ['부여', 15, ['horse_ranch', 'fur_lodge', 'yeonggo_altar']],
    ['읍루', 15, ['fur_lodge', 'nine_ladder_pit', 'hushi_armory']],
    ['옥저', 15, ['tiger_altar', 'sea_drying_rack', 'pony_pen']],
    ['목지국', 15, ['silk_loom', 'sodo', 'bead_workshop']],
    ['사로국', 15, ['silk_loom', 'iron_ingot_forge', 'seul_hall']],
    ['노국', 15, ['raised_storehouse', 'daewae_market', 'ghost_way_hall']],
    ['흉노', 16, ['horse_ranch', 'border_market', 'dragon_shrine']],
    ['선비', 16, ['horse_ranch', 'horn_bow', 'net_fishery']],
    ['오환', 16, ['border_market', 'dongqiang_field', 'white_liquor_tent']],
    ['강', 16, ['salt_pool', 'qionglong', 'yak_pasture']],
    ['저', 16, ['plank_house', 'di_loom', 'mule_pen']],
    ['남만', 16, ['panhu_shrine', 'bark_cloth']],
    ['산월', 16, ['mountain_forge', 'cliff_stronghold']],
    ['이주', 16, ['brine_jar_house', 'patterned_cloth', 'log_drum']],
  ] as const;
  it.each(places)('%s는 해당 양식 목록만 응답하고 나머지 건설을 거부한다', (name, region, expected) => {
    const state = setup(name, region);
    const info = cityLandInfo(state, 1, actor);
    expect(info.style).toBe(castleStyle(state.cities[1]));
    expect(info.buildings.every((spec) => spec.style === info.style)).toBe(true);
    expect(
      info.buildings
        .map((spec) => spec.key)
        .filter((key) => !legacyBuildings.some((spec) => spec.key === key))
        .sort(),
    ).toEqual([...expected].sort());
    expect(info.buildings).toHaveLength(48 + expected.length);
    for (const spec of BUILDINGS.slice(48)) {
      if (expected.includes(spec.key as never)) continue;
      const slot = cityLandSlots('CITY', 9).find((slot) => slot.zone === spec.zone)!;
      expect(buildingFailure(state, 1, slot.id, spec.key)?.message).toBe('이 지역에서만 지을 수 있는 건물입니다.');
    }
  });
  it('시험 거점이 22양식을 모두 포함한다', () => {
    expect(new Set(places.map(([name, region]) => castleStyle({ name, region })))).toEqual(new Set(CASTLE_STYLES));
  });
  it('양식 밖 기존 건물은 자리와 효과를 보존하고 응답 용량은 실제 용량과 같다', () => {
    const state = setup();
    put(state, 'jing_academy', '-1.5,-1.5');
    put(state, 'market', '-1.5,-0.5');
    put(state, 'mint', '-0.5,-0.5');
    const info = cityLandInfo(state, 1, actor);
    expect(info.buildings.some((spec) => spec.key === 'jing_academy')).toBe(false);
    expect(info.slots.find((slot) => slot.id === '-1.5,-1.5')?.building?.building).toBe('jing_academy');
    expect(info.slots.find((slot) => slot.id === '-1.5,-0.5')?.capacity).toBe(150);
    for (const spec of info.buildings)
      for (const slot of spec.slots) expect(slot.capacity).toBe(facilityCapacity(state, 1, slot.slotId, spec.key));
    expect(settle(state).generals[1]!.experience).toBe(state.generals[1]!.experience + 2);
  });
  it.each([
    ['farm', 'granary', '2.5,2.5', '2.5,3.5', 150],
    ['farm', 'bugyeong', '2.5,2.5', '1.5,1.5', 130],
    ['farm', 'raised_storehouse', '3.5,3.5', '1.5,1.5', 150],
    ['farm', 'raised_storehouse', '4.5,4.5', '1.5,1.5', 100],
    ['farm', 'pond_weir', '2.5,2.5', '2.5,3.5', 130],
    ['market', 'bead_workshop', '-1.5,-1.5', '-1.5,-0.5', 130],
    ['market', 'silk_loom', '-1.5,-1.5', '-1.5,-0.5', 120],
    ['market', 'yue_cloth', '-1.5,-1.5', '-1.5,-0.5', 120],
    ['border_market', 'mint', '-1.5,-1.5', '-1.5,-0.5', 225],
    ['canal_depot', 'granary', '5.5,5.5', '5.5,4.5', 180],
    ['dongqiang_field', 'granary', '2.5,2.5', '2.5,3.5', 165],
    ['chestnut_grove', 'granary', '2.5,2.5', '2.5,3.5', 120],
    ['yak_pasture', 'granary', '2.5,2.5', '2.5,3.5', 120],
  ] as const)('%s 곁 %s의 범위와 배수', (target, support, slot, neighbor, capacity) => {
    const state = setup();
    put(state, support, neighbor);
    expect(facilityCapacity(state, 1, slot, target)).toBe(capacity);
    state.campaign!.land!.cities['1']![0]!.remainingTurns = 1;
    expect(facilityCapacity(state, 1, slot, target)).toBe(buildingSpec(target).capacity);
  });
  it('같은 종류의 도움은 최댓값만 곱하고 다른 종류는 함께 적용한다', () => {
    const state = setup();
    put(state, 'granary', '2.5,3.5');
    put(state, 'bugyeong', '1.5,1.5');
    put(state, 'irrigation', '3.5,2.5');
    put(state, 'pond_weir', '3.5,3.5');
    expect(facilityCapacity(state, 1, '2.5,2.5', 'farm')).toBe(195);
    put(state, 'bead_workshop', '-1.5,-0.5');
    put(state, 'mint', '-0.5,-1.5');
    put(state, 'silk_loom', '-0.5,-0.5');
    put(state, 'yue_cloth', '0.5,-0.5');
    expect(facilityCapacity(state, 1, '-1.5,-1.5', 'market')).toBe(180);
  });
  it('물가·바다·산 조건과 산 용량을 적용한다', () => {
    const state = setup('성도', 9);
    expect(buildingFailure(state, 1, '5.5,5.5', 'salt_well')).toBeNull();
    expect(facilityCapacity(state, 1, '5.5,5.5', 'salt_well')).toBe(150);
    terrain(state, 'LAND', true);
    expect(facilityCapacity(state, 1, '5.5,5.5', 'salt_well')).toBe(180);
    expect(facilityCapacity(state, 1, '5.5,5.5', 'celadon_kiln')).toBe(150);
    Object.assign(state.cities[1]!, { name: '건업', region: 8 });
    expect(buildingFailure(state, 1, '5.5,5.5', 'ruxu_dock')).not.toBeNull();
    terrain(state, 'RIVER');
    expect(buildingFailure(state, 1, '5.5,5.5', 'ruxu_dock')).toBeNull();
    expect(buildingFailure(state, 1, '4.5,4.5', 'ruxu_dock')).not.toBeNull();
    state.cities[1]!.name = '옥저';
    expect(buildingFailure(state, 1, '5.5,5.5', 'sea_drying_rack')).not.toBeNull();
    terrain(state, 'SEA');
    expect(buildingFailure(state, 1, '5.5,5.5', 'sea_drying_rack')).toBeNull();
    state.cities[1]!.name = '사로국';
    expect(buildingFailure(state, 1, '3.5,3.5', 'iron_ingot_forge')).toBeNull();
    terrain(state, 'LAND');
    expect(buildingFailure(state, 1, '3.5,3.5', 'iron_ingot_forge')).not.toBeNull();
    terrain(state, 'LAND', true);
    expect(buildingFailure(state, 1, '3.5,3.5', 'iron_ingot_forge')).toBeNull();
  });
  it('솟대 별읍은 공사 중에도 양방향으로 군사 시설을 막고 돌탑 집은 군사 시설이 아니다', () => {
    const state = setup('목지국', 15);
    put(state, 'sodo', '5.5,5.5', 1);
    expect(buildingFailure(state, 1, '4.5,4.5', 'camp')?.message).toContain('솟대');
    state.campaign!.land!.cities['1'] = [];
    put(state, 'camp', '5.5,5.5', 1);
    expect(buildingFailure(state, 1, '3.5,3.5', 'sodo')?.message).toContain('솟대');
    expect(buildingFailure(state, 1, '2.5,2.5', 'sodo')).toBeNull();
    state.cities[1]!.name = '강';
    expect(buildingFailure(state, 1, '2.5,2.5', 'qionglong')).toBeNull();
  });
  it('목마장 두 개 제한과 감시 시장·암시장 상호 배제를 공사부터 적용한다', () => {
    const state = setup('흉노', 16);
    put(state, 'horse_ranch', '2.5,2.5', 1);
    put(state, 'horse_ranch', '3.5,3.5');
    expect(buildingFailure(state, 1, '4.5,4.5', 'horse_ranch')?.message).toContain('2개');
    put(state, 'horse_ranch', '4.5,4.5');
    expect(() => readCityLand(state)).toThrow('개수 상한');
    state.campaign!.land!.cities['1'] = [];
    state.cities[1]!.name = '노국';
    put(state, 'daewae_market', '-1.5,-1.5', 1);
    expect(buildingFailure(state, 1, '-1.5,-0.5', 'black_market')?.message).toContain('함께');
    state.campaign!.land!.cities['1'] = [];
    put(state, 'black_market', '-1.5,-1.5', 1);
    expect(buildingFailure(state, 1, '-1.5,-0.5', 'daewae_market')?.message).toContain('함께');
  });
  it.each([
    ['buddha_shrine', '낙양', 500],
    ['nine_ladder_pit', '읍루', 1500],
    ['plank_house', '저', 1000],
    ['qionglong', '강', 500],
  ] as const)('%s 인구 상한은 완공 때 한 번 더하고 철거 때 되돌린다', (building, name, amount) => {
    const before = setup(name);
    const slotId = cityLandSlots('CITY', 9).find((slot) => slot.zone === buildingSpec(building).zone)!.id;
    const working = applyEffects(before, build.execute(before, actor, { slotId, building }, rngFor('region')).effects);
    expect(working.cities[1]!.populationMax).toBe(before.cities[1]!.populationMax);
    const cancelled = applyEffects(working, demolish.execute(working, actor, { slotId }, rngFor('cancel')).effects);
    expect(cancelled.cities[1]!.populationMax).toBe(before.cities[1]!.populationMax);
    const finished = settle(settle(working));
    expect(finished.cities[1]!.populationMax).toBe(before.cities[1]!.populationMax + amount);
    expect(settle(finished).cities[1]!.populationMax).toBe(finished.cities[1]!.populationMax);
    const removed = applyEffects(finished, demolish.execute(finished, actor, { slotId }, rngFor('remove')).effects);
    expect(removed.cities[1]!.populationMax).toBe(before.cities[1]!.populationMax);
  });
  it('새 주거 효과는 폐허 저장 검증·복구와 복제를 통과한다', () => {
    const state = setup('읍루');
    const city = state.cities[1]!;
    const baseMax = Object.fromEntries(
      CITY_SCALE_FIELDS.map((field) => [field, city[`${field}Max`] * 10]),
    ) as NonNullable<State['cityRuins']>['cities'][number]['baseMax'];
    state.cityRuins = { version: 1, cities: [{ cityKey: 1, level: 9, stage: 0, baseMax }] };
    put(state, 'nine_ladder_pit', '-1.5,-1.5', 1);
    const finished = settle(state);
    expect(readCityRuins(finished.cityRuins, finished)).toBeDefined();
    for (const field of ['population', 'agriculture', 'commerce'] as const)
      finished.cities[1]![field] = Math.ceil(finished.cities[1]![`${field}Max`] * 0.9);
    const replay = { ...initialReplayState(commandInitial()), state: cloneWorld(finished) };
    const recovered = cityScaleFeature.settleMonthly!({ before: replay, settled: replay, tick: 3 * TICKS_PER_MONTH })
      .replay.state;
    expect(recovered.cities[1]!.populationMax).toBe(Math.floor(baseMax.population * 0.4) + 1500);
    expect(readCityRuins(recovered.cityRuins, recovered)).toBeDefined();
  });
  it.each([
    ['shrine', 1, 0, 0, 0, 0, 0],
    ['academy', 0, 1, 0, 0, 0, 0],
    ['ironworks', 0, 1, 0, 0, 0, 0],
    ['clinic', 0, 0, 5, 0, 0, 0],
    ['tavern', 0, 0, 0, 1, 0, 0],
    ['tally', 0, 0, 0, 1, 0, 0],
    ['bronze_terrace', 0, 0, 0, 5, 0, 0],
    ['drill_ground', 0, 0, 0, 0, 1, 0],
    ['band', 0, 0, 0, 0, 0, 1],
    ['horse_ranch', 0, 0, 0, 0, 1, 0],
    ['pony_pen', 0, 0, 0, 0, 1, 0],
    ['buddha_shrine', 1, 0, 0, 0, 0, 0],
    ['jing_academy', 0, 1, 0, 2, 0, 0],
    ['bayu_dance', 0, 0, 0, 0, 0, 2],
    ['bronze_drum_altar', 2, 0, 0, 0, 0, 0],
    ['suhyeol_altar', 1, 0, 0, 0, 0, 0],
    ['maek_bow', 0, 0, 0, 0, 1, 0],
    ['yeonggo_altar', 1, 0, 0, 0, 0, 0],
    ['tiger_altar', 1, 0, 0, 0, 0, 0],
    ['sodo', 2, 0, 0, 0, 0, 0],
    ['iron_ingot_forge', 0, 1, 0, 0, 0, 0],
    ['seul_hall', 0, 0, 0, 1, 0, 1],
    ['ghost_way_hall', 2, 0, 0, 0, 0, 0],
    ['dragon_shrine', 1, 0, 0, 0, 0, 0],
    ['horn_bow', 0, 0, 0, 0, 1, 0],
    ['white_liquor_tent', 0, 0, 0, 1, 0, 1],
    ['panhu_shrine', 2, 0, 0, 0, 0, 0],
    ['mountain_forge', 0, 1, 0, 0, 1, 0],
    ['log_drum', 1, 0, 0, 0, 0, 1],
  ] as const)('%s 월 효과와 적용 대상을 보존한다', (building, trust, tech, healing, experience, train, atmos) => {
    const state = setup();
    const slot = cityLandSlots('CITY', 9).find((slot) => slot.zone === buildingSpec(building).zone)!;
    put(state, building, slot.id);
    state.cities[1]!.trust = 50;
    state.nations[1]!.tech = 10;
    state.campaign!.units = [1, 2, 3].map((id) => ({
      id,
      ownerId: id,
      commanderId: id,
      troops: 100,
      crewType: 1100,
      train: 50,
      atmos: 50,
    }));
    state.campaign!.nextUnitId = 4;
    // 같은 성의 적국 장수와 다른 성의 아군은 효과 대상에서 빠진다.
    state.generals[2]!.cityKey = 1;
    state.generals[2]!.nationId = 2;
    state.generals[3]!.cityKey = 2;
    state.generals[3]!.nationId = 1;
    const hash = JSON.stringify(state);
    const result = settle(state);
    expect(JSON.stringify(state)).toBe(hash);
    expect(result.cities[1]!.trust).toBe(50 + trust);
    expect(result.nations[1]!.tech).toBe(10 + tech);
    expect(result.generals[1]!.injury).toBe(state.generals[1]!.injury - healing);
    expect(result.generals[1]!.experience).toBe(state.generals[1]!.experience + experience);
    expect(result.campaign!.units[0]).toMatchObject({ train: 50 + train, atmos: 50 + atmos });
    for (const id of [2, 3]) {
      expect(result.generals[id]).toEqual(state.generals[id]);
      expect(result.campaign!.units[id - 1]).toEqual(state.campaign!.units[id - 1]);
    }
  });
  it.each([
    ['suhyeol_altar', 10, 1, 5],
    ['tiger_altar', 10, 1, 5],
    ['dragon_shrine', 5, 1, 5],
    ['yeonggo_altar', 12, 4, 0],
  ] as const)('%s 제사는 지정한 달에만 추가 효과를 낸다', (building, month, trust, atmos) => {
    const state = setup();
    const slot = cityLandSlots('CITY', 9).find((slot) => slot.zone === buildingSpec(building).zone)!;
    put(state, building, slot.id);
    state.cities[1]!.trust = 50;
    state.campaign!.units = [{ id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 50, atmos: 50 }];
    const result = settle(state, month);
    expect(result.cities[1]!.trust).toBe(50 + trust);
    expect(result.campaign!.units[0]!.atmos).toBe(50 + atmos);
    const ordinary = settle(state, month === 12 ? 11 : month + 1);
    expect(ordinary.cities[1]!.trust).toBe(51);
    expect(ordinary.campaign!.units[0]!.atmos).toBe(50);
  });
  it('월 효과는 상한을 넘지 않고 미완공 건물에는 적용하지 않는다', () => {
    const state = setup();
    put(state, 'jing_academy', '-1.5,-1.5', 2);
    put(state, 'ghost_way_hall', '-1.5,-0.5');
    put(state, 'seul_hall', '-1.5,0.5');
    state.cities[1]!.trust = 100;
    state.campaign!.units = [
      { id: 1, ownerId: 1, commanderId: 1, troops: 100, crewType: 1100, train: 100, atmos: 100 },
    ];
    const result = settle(state);
    expect(result.cities[1]!.trust).toBe(100);
    expect(result.nations[1]!.tech).toBe(state.nations[1]!.tech);
    expect(result.generals[1]!.experience).toBe(state.generals[1]!.experience + 1);
    expect(result.campaign!.units[0]).toMatchObject({ train: 100, atmos: 100 });
  });
});
