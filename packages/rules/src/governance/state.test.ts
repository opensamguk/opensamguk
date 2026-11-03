import { describe, expect, it } from 'vitest';
import { cloneWorld } from '../model/clone';
import { deepFreeze } from '../personnel/testFixture';
import { readGovernanceConfig } from './config';
import { governanceRealmIndex, governanceUnionError } from './realm';
import { readGovernanceState } from './state';
import { governanceFixture, governanceTestConfig, vassal } from './testFixture';

describe('AC-P2-31 원생성·봉신 계열의 경계', () => {
  it('빈 황위 한 칸과 세 직위를 만들며 재정이나 이력을 복제하지 않는다', () => {
    const world = governanceFixture();
    expect(world.governance!.throne).toEqual({ emperorGeneralId: null, emperorNationId: null, sinceTick: 0 });
    expect(world.governance!.court).toEqual({ chancellor: null, grandMarshal: null, minister: null });
    expect(Object.values(world.governance!.legitimacy)).toEqual([0, 0, 0, 0, 0]);
    expect(world.governance).not.toHaveProperty('gold');
    expect(world.governance).not.toHaveProperty('history');
    const clone = cloneWorld(deepFreeze(world));
    clone.governance!.config.legitimacy.seatGain = 7;
    expect(world.governance!.config.legitimacy.seatGain).toBe(2);
    delete clone.governance;
    expect(cloneWorld(clone)).not.toHaveProperty('governance');
  });
  it('거점이 없거나 관문이면 천자 소재지로 쓰지 못한다', () => {
    const world = governanceFixture();
    expect(() => readGovernanceConfig({ ...governanceTestConfig, seatCityKey: 999 }, world)).toThrow('소재지');
    world.cities[1]!.kind = 'PASS';
    expect(() => readGovernanceConfig(governanceTestConfig, world)).toThrow('소재지');
  });
  it('구조 해제는 군주 교체를 받아들이며 반쪽 황위와 번호 재사용은 거부한다', () => {
    const world = governanceFixture(),
      state = world.governance!;
    state.vassals = [vassal(1, 2, 1)];
    state.nextVassalId = 2;
    world.generals[2]!.officerLevel = 0;
    expect(readGovernanceState(deepFreeze(state)).vassals).toHaveLength(1);
    expect(() =>
      readGovernanceState({ ...state, throne: { emperorGeneralId: 1, emperorNationId: null, sinceTick: 0 } }),
    ).toThrow();
    expect(() => readGovernanceState({ ...state, nextVassalId: 1 })).toThrow('번호');
    expect(() => readGovernanceState({ ...state, vassals: [state.vassals[0], state.vassals[0]] })).toThrow('번호');
  });
  it('최상위 0에서 세 간선까지 허용하고 네 번째 간선은 거부한다', () => {
    const world = governanceFixture(),
      state = world.governance!;
    state.vassals = [vassal(1, 2, 1), vassal(2, 3, 2), vassal(3, 4, 3)];
    state.nextVassalId = 4;
    expect(governanceRealmIndex(deepFreeze(world), state, 0).root(4)).toEqual({ nationId: 1, depth: 3 });
    expect(governanceUnionError(world, state, 4, 5, 0)).toBe('DEPTH_LIMIT');
    expect(governanceUnionError(world, state, 3, 5, 0)).toBeNull();
  });
  it('새 봉신의 하위 계열 전체 높이도 합류 깊이에 포함한다', () => {
    const world = governanceFixture(),
      state = world.governance!;
    state.vassals = [vassal(1, 2, 1), vassal(2, 3, 2), vassal(3, 5, 4)];
    state.nextVassalId = 4;
    expect(governanceUnionError(world, state, 3, 4, 0)).toBe('DEPTH_LIMIT');
    expect(governanceUnionError(world, state, 2, 4, 0)).toBeNull();
    expect(governanceUnionError(world, state, 1, 2, 0)).toBe('ALREADY_VASSAL');
  });
  it.each(['WAR', 'DECLARED'] as const)('서로의 하위 국가 사이 %s도 계열 합류를 막고 외교를 보존한다', (relation) => {
    const world = governanceFixture(),
      state = world.governance!;
    state.vassals = [vassal(1, 2, 1), vassal(2, 3, 2), vassal(3, 5, 4)];
    state.nextVassalId = 4;
    world.diplomacies = [{ nationA: 3, nationB: 5, state: relation, untilTick: 0 }];
    expect(governanceUnionError(deepFreeze(world), state, 1, 4, 0)).toBe('REALM_AT_WAR');
    expect(world.diplomacies).toEqual([{ nationA: 3, nationB: 5, state: relation, untilTick: 0 }]);
  });
  it('조상 국가를 자기 아래로 넣는 순환과 손상된 중복 상위 관계를 거부한다', () => {
    const world = governanceFixture(),
      state = world.governance!;
    state.vassals = [vassal(1, 2, 1)];
    state.nextVassalId = 2;
    expect(governanceUnionError(world, state, 2, 1, 0)).toBe('CYCLE');
    state.vassals.push(vassal(2, 1, 2));
    state.nextVassalId = 3;
    expect(() => governanceRealmIndex(world, state, 0)).toThrow('순환');
    state.vassals = [vassal(1, 2, 1), vassal(2, 2, 3)];
    expect(() => governanceRealmIndex(world, state, 0)).toThrow('중복');
  });
  it('기존 서명 군주가 바뀌면 저장 정리 전에도 이전 계열 권한을 쓰지 않는다', () => {
    const world = governanceFixture(),
      state = world.governance!;
    state.vassals = [vassal(1, 2, 1), vassal(2, 3, 2)];
    state.nextVassalId = 3;
    world.generals[2]!.officerLevel = 0;
    const index = governanceRealmIndex(deepFreeze(world), state, 0);
    expect(index.root(2).nationId).toBe(2);
    expect(index.root(3).nationId).toBe(3);
    expect(world.governance!.vassals).toHaveLength(2);
  });
});
