import { describe, expect, it } from 'vitest';
import { operationalInput } from '../../test/operationalMapFixture';
import { buildInitialWorld, type WorldInit } from '../world/bootstrap';
import { cloneWorld } from '../model/clone';
import { initialReplayState } from '../replay';
import { checkReplayOrigin, settleMonthlyFeatures } from '../ruleRegistry';
import { cityScaleFeature } from './feature';
import { checkCityScaleInitial, readCityRuins } from './state';
import { CITY_SCALE_FIELDS } from '../world/map/cityScale';

function fixture() {
  const input = operationalInput();
  return buildInitialWorld({
    ...input,
    scenario: { ...input.scenario, cityScale: { cities: [{ city: '도시1', ruin: true }] } },
  });
}
function origin(initial: WorldInit) {
  return { version: 3 as const, initial, initialStateHash: 'transport-checked', resourceHash: 'transport-checked' };
}
const settle = (replay: ReturnType<typeof initialReplayState>) => settleMonthlyFeatures(replay, replay, 1).replay;
function fill(replay: ReturnType<typeof initialReplayState>, percent = 90) {
  const city = replay.state.cities[1]!;
  for (const field of ['population', 'agriculture', 'commerce'] as const)
    city[field] = Math.ceil((city[`${field}Max`] * percent) / 100);
}

describe('AC-INT-21 선택 기능과 결정적 폐허 복구', () => {
  it('기존 생성에는 새 키가 없고 폐허 생성은 운영 지도 엄격 검사와 재생 시작 검사를 통과한다', () => {
    const old = buildInitialWorld(operationalInput());
    expect(old).not.toHaveProperty('cityScale');
    expect(initialReplayState(old).state).not.toHaveProperty('cityRuins');
    const initial = fixture();
    expect(initial.ruleFeatures).toEqual(['city-scale-v1', 'five-stats', 'operational-map']);
    expect(() => checkReplayOrigin(origin(initial))).not.toThrow();
    const state = initialReplayState(initial).state;
    expect(state.cities[1]).toMatchObject({ level: 1, populationMax: 200, agricultureMax: 10, commerceMax: 10 });
    expect(state.cityRuins).toEqual({
      version: 1,
      cities: [{ cityKey: 1, level: 1, stage: 0, baseMax: initial.cityScale!.cities[0]!.max }],
    });
    expect(() => readCityRuins(state.cityRuins, state)).not.toThrow();
  });

  it('10→40→70→100에서 한 달 한 단계만 올리고 마지막에는 폐허를 해제한다', () => {
    let replay = initialReplayState(fixture());
    const initial = structuredClone(replay);
    const base = replay.state.cityRuins!.cities[0]!.baseMax;
    for (const percent of [40, 70, 100]) {
      fill(replay);
      const values = CITY_SCALE_FIELDS.map((field) => replay.state.cities[1]![field]);
      replay = settle(replay);
      for (const field of CITY_SCALE_FIELDS)
        expect(replay.state.cities[1]![`${field}Max`]).toBe(Math.floor((base[field] * percent) / 100));
      expect(CITY_SCALE_FIELDS.map((field) => replay.state.cities[1]![field])).toEqual(values);
      expect(replay.state.cities[1]!.level).toBe(1);
      expect(() => readCityRuins(replay.state.cityRuins, replay.state)).not.toThrow();
    }
    expect(replay.state.cityRuins).toEqual({ version: 1, cities: [] });
    expect(initial.state.cityRuins!.cities[0]!.stage).toBe(0);
  });

  it.each(['population', 'agriculture', 'commerce'] as const)(
    '%s가 90% 미만이면 복구하지 않고 정확한 경계에서 복구한다',
    (field) => {
      const replay = initialReplayState(fixture());
      fill(replay);
      const city = replay.state.cities[1]!;
      city[field] = Math.ceil(city[`${field}Max`] * 0.9) - 1;
      expect(settle(replay).state.cityRuins!.cities[0]!.stage).toBe(0);
      city[field]++;
      expect(settle(replay).state.cityRuins!.cities[0]!.stage).toBe(1);
    },
  );

  it('공백지는 복구되지 않으며 소유 국가가 바뀌어도 현재 단계에서 이어 간다', () => {
    let replay = initialReplayState(fixture());
    fill(replay);
    replay.state.cities[1]!.nationId = null;
    expect(settle(replay).state.cityRuins!.cities[0]!.stage).toBe(0);
    replay.state.cities[1]!.nationId = 2;
    replay = settle(replay);
    expect(replay.state.cityRuins!.cities[0]!.stage).toBe(1);
    replay.state.cities[1]!.nationId = 1;
    fill(replay);
    expect(settle(replay).state.cityRuins!.cities[0]!.stage).toBe(2);
  });

  it('복제한 폐허 원장을 수정해도 원본과 생성 기록은 바뀌지 않는다', () => {
    const initial = fixture();
    const replay = initialReplayState(initial);
    const copy = cloneWorld(replay.state);
    copy.cityRuins!.cities[0]!.baseMax.population++;
    expect(replay.state.cityRuins!.cities[0]!.baseMax.population).toBe(2000);
    expect(initial.cityScale!.cities[0]!.max.population).toBe(2000);
  });

  it.each(['level', 'populationMax', 'agriculture'] as const)('생성 도시의 %s 변조를 거부한다', (field) => {
    const initial = fixture();
    initial.cities[0]![field]++;
    expect(() => checkReplayOrigin(origin(initial))).toThrow();
  });

  it('생성 원장·기능·최대치 변조와 없는 기능의 저장값을 거부한다', () => {
    const initial = fixture();
    initial.cityScale!.cities[0]!.max.population++;
    expect(() => checkReplayOrigin(origin(initial))).toThrow();
    const disabled = fixture();
    disabled.ruleFeatures = ['five-stats', 'operational-map'];
    expect(() => checkCityScaleInitial(disabled)).toThrow('끈');
    const replay = initialReplayState(fixture());
    expect(() => readCityRuins(null, replay.state)).toThrow();
    expect(() => readCityRuins(replay.state.cityRuins, { ...replay.state, ruleFeatures: [] })).toThrow('끈');
    replay.state.cities[1]!.wallMax++;
    expect(() => readCityRuins(replay.state.cityRuins, replay.state)).toThrow('최대치');
  });

  it('legacy 지도에서도 같은 선택 규칙을 쓰고 운영 지도 의존을 강제하지 않는다', () => {
    const input = operationalInput();
    const city = {
      id: 1,
      name: '마을',
      level: 5,
      region: 1,
      position: { x: 1, y: 1 },
      connections: [],
      max: { population: 10000, agriculture: 200, commerce: 200, security: 200, defence: 200, wall: 200 },
      initial: { population: 1000, agriculture: 0, commerce: 0, security: 0, defence: 100, wall: 100 },
    };
    const initial = buildInitialWorld({
      ...input,
      map: { id: 'legacy', name: '기존 지도', cities: [city], defaults: { trust: 80, supplyState: 1 } },
      statRules: { stat: { total: 150, min: 0, max: 100 } },
      scenario: {
        id: 'legacy',
        title: '기존 지도',
        startYear: 191,
        nation: [],
        general: [],
        diplomacy: [],
        cityScale: { cities: [{ city: '마을', level: 0 }] },
      },
    });
    expect(initial.ruleFeatures).toEqual(['city-scale-v1']);
    expect(() => checkReplayOrigin(origin(initial))).not.toThrow();
    expect(initialReplayState(initial).state.cityRuins).toEqual({ version: 1, cities: [] });
    expect(cityScaleFeature.requires).toEqual([]);
  });

  it('현재 단계 상한이 같아도 100% 최대치 변조와 미복구 항목 누락을 생성 원장 대조로 거부한다', () => {
    const initial = fixture();
    const replay = initialReplayState(initial);
    const altered = structuredClone(replay.state.cityRuins);
    altered!.cities[0]!.baseMax.population++;
    expect(() => readCityRuins(altered, replay.state, initial.cityScale)).toThrow('생성 원장');
    expect(() => readCityRuins({ version: 1, cities: [] }, replay.state, initial.cityScale)).toThrow('해제');
    for (const field of CITY_SCALE_FIELDS)
      replay.state.cities[1]![`${field}Max`] = initial.cityScale!.cities[0]!.max[field];
    expect(readCityRuins({ version: 1, cities: [] }, replay.state, initial.cityScale)).toEqual({
      version: 1,
      cities: [],
    });
  });
});
