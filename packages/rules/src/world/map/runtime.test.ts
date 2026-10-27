import { describe, expect, it } from 'vitest';
import { operationalInput } from '../../../test/operationalMapFixture';
import { buildInitialWorld } from '../bootstrap';
import { validateWorldResources } from '../validate/world';
import { validateMap } from '../validate/map';
import { normalizeMapToV2 } from './format';
import { checkOperationalProfile } from './profile';
import { attachOperationalKinds, operationalMapDisplay, readOperationalMap } from './stored';
import { toWorldState } from '../../model/world';
import { settlePopulation } from '../../monthly';
import { unifiedNation } from '../../season';
import { removeNation } from '../../commands/support';
import { commands } from '../../commands/registry';
import { applyTreatyInput } from '../../diplomacy/treaty';

describe('AC-INT-02 운영 지도 생성·경제 경계', () => {
  it('게시 가능한 자원을 같은 앵커·불변 원장으로 생성하고 구형 변환은 거부한다', () => {
    const input = operationalInput(),
      before = structuredClone(input);
    expect(validateWorldResources(input).status).toBe('pass');
    const initial = buildInitialWorld(input);
    expect(() => checkOperationalProfile(initial)).not.toThrow();
    expect(initial.ruleFeatures).toEqual(['five-stats', 'operational-map']);
    expect(initial.cities.map(({ cityKey, kind, connections }) => ({ cityKey, kind, connections }))).toEqual([
      { cityKey: 1, kind: 'CITY', connections: [99] },
      { cityKey: 2, kind: 'CITY', connections: [99] },
      { cityKey: 99, kind: 'PASS', connections: [1, 2] },
    ]);
    expect(initial.operationalMap).toEqual(input.map);
    expect(initial.cities[2]).toMatchObject({
      level: 0,
      population: 0,
      agriculture: 0,
      commerce: 0,
      security: 0,
      defence: 100,
      wall: 100,
    });
    expect(normalizeMapToV2(input.map).ok).toBe(false);
    expect(input).toEqual(before);
  });

  it('단방향 순환은 허용하고 차단·일방 고립과 관문 수도는 거부한다', () => {
    const input = operationalInput();
    input.map.routes[0]!.direction = 'FORWARD';
    expect(validateMap(input.map, { scenarios: [] }).status).toBe('fail');
    input.map.routes.push({
      id: 'route:return',
      from: 'city:2',
      to: 'city:1',
      mode: 'LAND',
      direction: 'FORWARD',
      enabled: true,
    });
    expect(validateMap(input.map, { scenarios: [] }).status).toBe('pass');
    input.map.routes[2]!.enabled = false;
    expect(() => buildInitialWorld(input)).toThrow();
    input.map.routes[0]!.direction = 'BOTH';
    input.scenario.nation[0]![8] = ['관문', '도시1'];
    expect(validateWorldResources(input).status).toBe('fail');
    expect(() => buildInitialWorld(input)).toThrow('수도');
  });

  it('동명 항구·전장이 도시보다 앞에 있어도 수도의 유효성은 변하지 않는다', () => {
    const input = operationalInput();
    input.map.sites.unshift(
      { id: 'port:same', kind: 'PORT', name: '도시1', parentCityId: 'city:1', position: { x: 120, y: 210 } },
      { id: 'field:same', kind: 'FIELD', name: '도시2', position: { x: 320, y: 410 } },
    );
    expect(validateWorldResources(input).status).toBe('pass');
    expect(buildInitialWorld(input).nations.map((nation) => nation.capitalCityKey)).toEqual([1, 2]);
  });

  it('연결된 시나리오의 수도를 관문으로 바꾸는 지도 재게시를 거부한다', () => {
    const input = operationalInput();
    input.map.sites[0] = {
      id: 'pass:1',
      kind: 'PASS',
      name: '도시1',
      anchorKey: 1,
      region: 1,
      position: { x: 100, y: 200 },
      defence: { initial: 100, max: 500 },
      wall: { initial: 100, max: 500 },
    };
    input.map.routes[0]!.from = 'pass:1';
    const port = input.map.sites.find((site) => site.kind === 'PORT')!;
    if (port.kind !== 'PORT') throw new Error('항구 고정물이 없습니다.');
    port.parentCityId = 'city:2';
    expect(validateMap(input.map, { scenarios: [] }).status).toBe('pass');
    expect(validateMap(input.map, { scenarios: [input.scenario] }).status).toBe('fail');
    expect(() => buildInitialWorld(input)).toThrow('수도');
  });

  it('한 도시와 한 관문을 가진 국가의 12개월 불가침 비용은 도시 한 개의 금100이다', () => {
    const state = toWorldState(buildInitialWorld(operationalInput()));
    for (const nation of Object.values(state.nations)) {
      nation.isNpc = false;
      nation.gold = 100;
    }
    const proposed = applyTreatyInput(
      state,
      {
        generalId: 1,
        kind: 'treaty.propose',
        payload: { toNationId: 2, clauses: [{ kind: 'nonAggression', months: 12 }] },
      },
      { tick: 1, sequence: 1 },
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) throw new Error('불가침 제안 실패');
    const accepted = applyTreatyInput(
      proposed.state,
      { generalId: 2, kind: 'treaty.respond', payload: { treatyId: '1', accept: true } },
      { tick: 2, sequence: 2 },
    );
    expect(accepted).toMatchObject({
      ok: true,
      result: { cost: { from: 100, to: 100 } },
      state: { nations: { 1: { gold: 0 }, 2: { gold: 0 } } },
    });
  });

  it('원장·종류·초기 경제의 변조와 구형 판의 추가 필드를 거부한다', () => {
    const initial = buildInitialWorld(operationalInput());
    for (const change of [
      (value: typeof initial) => {
        value.cities[2]!.kind = 'CITY';
      },
      (value: typeof initial) => {
        value.cities[2]!.population = 1;
      },
      (value: typeof initial) => {
        value.cities[0]!.connections = [2];
      },
      (value: typeof initial) => {
        value.nations[0]!.capitalCityKey = 99;
      },
      (value: typeof initial) => {
        value.ruleFeatures = ['five-stats'];
      },
    ]) {
      const invalid = structuredClone(initial);
      change(invalid);
      expect(() => checkOperationalProfile(invalid)).toThrow();
    }
    const map = readOperationalMap(initial.operationalMap, initial.ruleFeatures!, { initial })!;
    const altered = structuredClone(map);
    altered.sites[0]!.position.x++;
    expect(() => readOperationalMap(altered, initial.ruleFeatures!, { initial })).toThrow('생성 기록');
    expect(() =>
      attachOperationalKinds(
        initial.cities.map((city) => ({ ...city, kind: null })),
        map,
      ),
    ).toThrow();
    expect(attachOperationalKinds([{ cityKey: 1, kind: null }], undefined)).toEqual([{ cityKey: 1 }]);
    expect(operationalMapDisplay(map).sites.every((site) => !('initial' in site) && !('max' in site))).toBe(true);
  });

  it('관문의 경제·수도·건국·도시 승리 집계를 막고 기존 수비 보강·주둔은 유지한다', () => {
    const state = toWorldState(buildInitialWorld(operationalInput()));
    const pass = state.cities[99]!;
    const before = structuredClone(pass);
    expect(settlePopulation(state).cities[99]).toEqual(before);
    state.generals[1]!.cityKey = 99;
    const farm = commands.find((command) => command.key === 'farm')!;
    expect(farm.check(state, { generalId: 1 }, {})).toMatchObject({ code: 'BAD_TARGET' });
    const defence = commands.find((command) => command.key === 'defence')!;
    expect(defence.check(state, { generalId: 1 }, {})).toBeNull();
    const capital = commands.find((command) => command.key === 'nation_capital')!;
    expect(capital.check(state, { generalId: 1 }, { cityKey: 99 })).toMatchObject({ code: 'BAD_TARGET' });
    state.cities[2]!.nationId = 1;
    removeNation(state, 2);
    pass.nationId = null;
    expect(unifiedNation(state)).toBe(1);
    pass.nationId = 1;
    removeNation(state, 1);
    expect(pass.nationId).toBeNull();
  });
});
