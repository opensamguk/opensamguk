import { describe, expect, it, vi } from 'vitest';
import { createRng, type Rng } from '@opensamguk/shared';
import { commandWorld } from '../../../../test/commandFixture';
import { TICKS_PER_MONTH } from '../../../clock/constants';
import { cloneWorldWithRegistry } from '../../../model/clone';
import type { WorldState } from '../../../model/world';
import { createCommandResolver, createCommandResolverWithCommands } from '../../resolve';
import type { Actor, Failure } from '../../types';
import { createExtStateWithRegistry } from '../state';
import { buildIntelRecord, INTEL, intelDistance, intelLevel, techCompare } from './base';
import { intelBindings, intelCommands, intelSlices } from './index';
import { intelSlice, type IntelRecord, type IntelSliceValue, type IntelTech } from './record';
import { makeSpyCommand, spy } from './spy';

const registry = { slices: intelSlices, bindings: intelBindings };
const enabled = { general: ['spy'], nation: [] };
const command = makeSpyCommand((view) => cloneWorldWithRegistry(view, registry));
const resolver = createCommandResolverWithCommands(enabled, [command]);
const actor = { generalId: 1, tick: 120_000 };
const args = { cityKey: 2 };

function world() {
  const state = commandWorld();
  state.ext = createExtStateWithRegistry(enabled, state, registry)!;
  state.generals[3]!.crewType = 1200;
  state.cities[2]!.trust = 73.25;
  return state;
}
function run(state = world(), currentActor: Actor = actor, cityKey = 2, rng = createRng('intel-golden')) {
  const result = resolver.run(state, currentActor, 'spy', { cityKey }, rng);
  if ('code' in result) throw new Error(result.message);
  expect(result.effects).toHaveLength(1);
  const effect = result.effects[0]!;
  if (effect.kind !== 'world') throw new Error('월드 효과가 필요합니다.');
  return { result, state: effect.state, intel: effect.state.ext!.intel as IntelSliceValue };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
const domestic = {
  agriculture: 100,
  agricultureMax: 1000,
  commerce: 100,
  commerceMax: 1000,
  security: 100,
  securityMax: 1000,
  defence: 0,
  defenceMax: 1000,
  wall: 10,
  wallMax: 1000,
};
function golden(level: 1 | 2 | 3): IntelRecord {
  return {
    tick: 120_000,
    level,
    owner: { id: 2, name: '국가2', color: '#0000ff' },
    population: 20000,
    populationMax: 50000,
    trust: 73.25,
    generals: 2,
    crew: 30,
    ...(level <= 2 ? { domestic } : {}),
    ...(level === 1
      ? {
          crewTypes: [
            { crewType: 1100, generals: 1 },
            { crewType: 1200, generals: 1 },
          ],
          tech: 'even' as const,
        }
      : {}),
  };
}

describe('AC-P2-07 첩보 규칙', () => {
  it.each([
    [1, 1, '정보를 많이 얻었습니다'],
    [2, 4, '정보를 어느 정도 얻었습니다'],
    [3, 1, '소문만 들었습니다'],
  ] as const)('V1·V3 단계 %i 성공 골든과 선택 칸', (level, from, message) => {
    const state = world();
    state.generals[1]!.cityKey = from;
    if (level === 3) state.cities[1]!.connections = [];
    const output = run(state);
    expect(output.intel).toEqual({ '1': { '2': golden(level) } });
    expect(output.state.generals[1]).toEqual({
      ...state.generals[1],
      gold: 100000 - INTEL.COST_GOLD,
      rice: 100000 - INTEL.COST_RICE,
      experience: 72,
      dedication: 49,
    });
    expect(output.result).toEqual({
      effects: [{ kind: 'world', state: output.state }],
      logs: [{ kind: 'success', text: `첩보: 도시2 ${message}` }],
      history: [{ nationId: 2, text: '도시2: 누군가 이 도시를 살폈습니다' }],
    });
    const record = output.intel['1']!['2']!;
    for (const [field, present] of [
      ['domestic', level <= 2],
      ['crewTypes', level === 1],
      ['tech', level === 1],
    ] as const)
      expect(Object.hasOwn(record, field)).toBe(present);
    expect(intelSlice.validate(output.intel)).toBe(true);
  });

  it.each([
    [2, 0, 1],
    [1, 1, 1],
    [4, 2, 2],
    [99, 3, 3],
  ] as const)('V2 출발 %i 거리 %i 단계 %i', (from, distance, level) => {
    const state = world();
    state.generals[1]!.cityKey = from;
    expect(intelDistance(state, from, 2)).toBe(distance);
    expect(run(state).intel['1']!['2']!.level).toBe(level);
  });
  it('V2 세 칸 거리, 순환, 없는 연결, 끊긴 연결을 처리한다', () => {
    const state = world();
    state.cities[4]!.nationId = 2;
    state.cities[1]!.connections.unshift(99, 1);
    expect(intelDistance(state, 1, 4)).toBe(3);
    expect(intelLevel(3)).toBe(3);
    expect(run(state, actor, 4).intel['1']!['4']!.level).toBe(3);
    state.cities[2]!.connections = [1];
    expect(intelDistance(state, 1, 4)).toBe(3);
  });

  it('V4 다른 국가·재야·미등장 장수를 빼고 등장 연도 경계는 센다', () => {
    const state = world();
    const target = state.generals[2]!;
    state.generals[3]!.nationId = 1;
    state.generals[4]!.cityKey = 2;
    state.generals[5] = { ...target, id: 5, crew: 1000, activeFromYear: 193 };
    state.generals[6] = { ...target, id: 6, crew: 5, activeFromYear: 192, crewType: 1000 };
    expect(run(state).intel['1']!['2']).toEqual({
      ...golden(1),
      generals: 2,
      crew: 25,
      crewTypes: [
        { crewType: 1000, generals: 1 },
        { crewType: 1100, generals: 1 },
      ],
    });
    expect(buildIntelRecord(state, { generalId: 1 }, 2).crew).toBe(20);
    expect(buildIntelRecord(state, { generalId: 1 }, 2).tick).toBe(0);
  });
  it('V4 공백지는 그 도시 재야만 세며 기술과 국가 알림이 없다', () => {
    const state = world();
    state.cities[2]!.nationId = null;
    state.generals[4]!.cityKey = 2;
    const output = run(state);
    const expected = {
      ...golden(1),
      owner: null,
      generals: 1,
      crew: 100,
      crewTypes: [{ crewType: 1100, generals: 1 }],
    };
    delete expected.tech;
    expect(output.intel['1']!['2']).toStrictEqual(expected);
    expect(Object.hasOwn(output.intel['1']!['2']!, 'tech')).toBe(false);
    expect(Object.hasOwn(output.result, 'history')).toBe(false);
    expect(intelSlice.validate(output.intel)).toBe(true);
  });
  it('V4 장수가 없는 도시의 병종 목록은 비어 있다', () => {
    const state = world();
    delete state.generals[2];
    delete state.generals[3];
    expect(run(state).intel['1']!['2']).toMatchObject({ generals: 0, crew: 0, crewTypes: [] });
  });

  it.each<[number, IntelTech]>([
    [1000, 'overwhelming'],
    [999, 'ahead'],
    [250, 'ahead'],
    [249, 'even'],
    [-250, 'even'],
    [-251, 'behind'],
    [-1000, 'behind'],
    [-1001, 'far_behind'],
  ])('V5 기술 차 %i는 %s', (diff, expected) => {
    const state = world();
    state.nations[1]!.tech = 2000.9;
    state.nations[2]!.tech = 2000 + diff + 0.1;
    expect(techCompare(state.nations[2]!.tech, state.nations[1]!.tech)).toBe(expected);
    expect(run(state).intel['1']!['2']!.tech).toBe(expected);
  });

  it('V6 낮은 단계로 다시 첩보해도 새 기록으로 교체하고 다른 국가 기록은 보존한다', () => {
    const first = run();
    first.intel['2'] = { '2': golden(1) };
    first.state.generals[1]!.cityKey = 99;
    first.state.cities[2]!.population = 123;
    first.state.nations[2]!.name = '새 국호';
    const second = run(first.state, { ...actor, tick: 240_000 });
    expect(second.intel).toEqual({
      '1': {
        '2': { ...golden(3), tick: 240_000, population: 123, owner: { id: 2, name: '새 국호', color: '#0000ff' } },
      },
      '2': { '2': golden(1) },
    });
    expect(first.intel['1']!['2']).toEqual(golden(1));
  });

  it('V7·V10 정리는 삽입 순서와 무관하며 RNG는 경험·공헌 두 번만 쓴다', () => {
    const outputs = [];
    for (const order of [
      [1, 2, 3],
      [3, 2, 1],
    ]) {
      const state = world();
      state.ext!.intel = Object.fromEntries(order.map((id) => [String(id), { '3': golden(3) }]));
      const rng = createRng('intel-cleanup');
      const int = vi.spyOn(rng, 'int');
      const next = vi.spyOn(rng, 'next');
      const pick = vi.spyOn(rng, 'pick');
      const output = run(state, actor, 2, rng);
      expect(int.mock.calls).toEqual([
        [1, 100],
        [1, 70],
      ]);
      expect(next).not.toHaveBeenCalled();
      expect(pick).not.toHaveBeenCalled();
      expect(Object.keys(output.intel)).toEqual(['1', '2']);
      expect(output.intel['1']!['3']).toEqual(golden(3));
      expect(output.intel['2']).toEqual({ '3': golden(3) });
      outputs.push(output);
    }
    expect(outputs[0]).toEqual(outputs[1]);
  });
  it('V7 같은 시드의 결과와 다음 난수가 같다', () => {
    const first = createRng('intel-repeat');
    const second = createRng('intel-repeat');
    expect(run(world(), actor, 2, first)).toEqual(run(world(), actor, 2, second));
    expect(first.next()).toBe(second.next());
  });
  it('V8 입력을 깊게 얼려도 world 효과 하나만 내며 입력은 바뀌지 않는다', () => {
    const state = world();
    (state.ext!.intel as IntelSliceValue)['2'] = { '2': golden(1) };
    const before = structuredClone(state);
    const output = run(freeze(state));
    expect(state).toEqual(before);
    expect(output.state).not.toBe(state);
    output.intel['2']!['2']!.domestic!.wall = 999;
    expect(state).toEqual(before);
    expect(output.state.cities[2]).not.toBe(state.cities[2]);
  });

  it('V9 조각 생성·복제·JSON 왕복', () => {
    expect(intelSlice.create(freeze(commandWorld()))).toEqual({});
    expect(intelSlice.create(commandWorld())).not.toBe(intelSlice.create(commandWorld()));
    const output = run();
    const cloned = intelSlice.clone(freeze(output.intel));
    expect(cloned).toEqual(output.intel);
    cloned['1']!['2']!.owner!.name = '변경';
    cloned['1']!['2']!.domestic!.wall = 99;
    cloned['1']!['2']!.crewTypes![0]!.generals = 99;
    expect(output.intel['1']!['2']).toEqual(golden(1));
    const roundtrip: unknown = JSON.parse(JSON.stringify(output.state));
    expect(roundtrip).toStrictEqual(output.state);
    expect(intelSlice.validate((roundtrip as WorldState).ext!.intel)).toBe(true);
    for (const off of [null, { general: [], nation: [] }]) {
      expect(createExtStateWithRegistry(off, commandWorld(), registry)).toBeUndefined();
      expect(Object.hasOwn(commandWorld(), 'ext')).toBe(false);
    }
  });

  it.each([{}, { cityKey: 0 }, { cityKey: 1.5 }, { cityKey: 2, extra: 1 }, { cityKey: 1_000_001 }])(
    'X3 잘못된 인자 %j',
    (badArgs) => {
      expect(resolver.precheck(world(), actor, 'spy', badArgs)).toEqual({
        code: 'BAD_ARGS',
        message: '명령 인자가 잘못되었습니다.',
      });
      expect(resolver.run(world(), actor, 'spy', badArgs, createRng('bad'))).toEqual({
        code: 'BAD_ARGS',
        message: '명령 인자가 잘못되었습니다.',
      });
    },
  );
  it('X4·X5 국가 대상·꺼진 명령·운영 미등록을 거부한다', () => {
    const state = world();
    expect(resolver.run(state, { ...actor, target: 'nation' }, 'spy', args, createRng('bad'))).toEqual({
      code: 'BAD_ARGS',
      message: '명령 대상이 다릅니다.',
    });
    const off = createCommandResolverWithCommands(null, intelCommands);
    expect(off.run(state, actor, 'spy', args, createRng('bad'))).toEqual({
      code: 'COMMAND_DISABLED',
      message: '이 월드에서 꺼진 명령입니다.',
    });
    expect(off.get('spy')).toBeUndefined();
    expect(off.list('general').some((def) => def.key === 'spy')).toBe(false);
    expect(createCommandResolver(null).run(state, actor, 'spy', args, createRng('bad'))).toEqual({
      code: 'UNKNOWN_COMMAND',
      message: '없는 명령입니다.',
    });
    expect(resolver.get('spy')).toBe(command);
    expect(spy.check).toBe(spy.precheck);
  });

  const failures: { name: string; prepare(state: WorldState): void; code: Failure['code']; message: string }[] = [
    {
      name: '장수 없음',
      prepare: (s) => {
        delete s.generals[1];
      },
      code: 'NO_ACTOR',
      message: '장수가 없습니다.',
    },
    {
      name: '재야',
      prepare: (s) => {
        s.generals[1]!.nationId = null;
      },
      code: 'NOT_NATION',
      message: '국가에 소속되어야 합니다.',
    },
    {
      name: '없는 국가',
      prepare: (s) => {
        delete s.nations[1];
      },
      code: 'NOT_NATION',
      message: '국가에 소속되어야 합니다.',
    },
    {
      name: '없는 대상',
      prepare: (s) => {
        delete s.cities[2];
      },
      code: 'BAD_TARGET',
      message: '없는 도시입니다.',
    },
    {
      name: '자기 국가 대상',
      prepare: (s) => {
        s.cities[2]!.nationId = 1;
      },
      code: 'BAD_TARGET',
      message: '자기 국가 도시는 첩보할 수 없습니다.',
    },
    {
      name: '금 부족',
      prepare: (s) => {
        s.generals[1]!.gold = INTEL.COST_GOLD - 1;
      },
      code: 'NO_GOLD',
      message: '금이 부족합니다.',
    },
    {
      name: '쌀 부족',
      prepare: (s) => {
        s.generals[1]!.rice = INTEL.COST_RICE - 1;
      },
      code: 'NO_RICE',
      message: '쌀이 부족합니다.',
    },
  ];
  it.each(failures)('X1·X6 $name', ({ prepare, code, message }) => {
    const state = world();
    prepare(state);
    const before = structuredClone(state);
    const rng: Rng = { next: vi.fn(), int: vi.fn(), pick: vi.fn() };
    expect(command.check(state, actor, args)).toEqual({ code, message });
    expect(resolver.precheck(state, actor, 'spy', args)).toEqual({ code, message });
    expect(resolver.run(state, actor, 'spy', args, rng)).toEqual({ code, message });
    expect(() => command.execute(state, actor, args, rng)).toThrow(message);
    expect(rng.int).not.toHaveBeenCalled();
    expect(rng.next).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });
  it('X1 검사 순서는 대상·금·쌀 순이다', () => {
    const state = world();
    Object.assign(state.generals[1]!, { gold: 0, rice: 0 });
    expect(command.check(state, actor, { cityKey: 99 })?.code).toBe('BAD_TARGET');
    expect(command.check(state, actor, args)?.code).toBe('NO_GOLD');
    state.generals[1]!.gold = INTEL.COST_GOLD;
    expect(command.check(state, actor, args)?.code).toBe('NO_RICE');
  });
  it('X2 출발 도시 소유·보급·대상 불가침을 검사하지 않는다', () => {
    const state = world();
    Object.assign(state.cities[1]!, { nationId: 2, supplied: false });
    state.diplomacies[0]!.state = 'NON_AGGRESSION';
    expect(command.check(state, actor, args)).toBeNull();
    expect(run(state).intel['1']!['2']).toEqual(golden(1));
  });
  it('X6 비용과 정확히 같은 금·쌀은 0까지 소비한다', () => {
    const state = world();
    Object.assign(state.generals[1]!, { gold: INTEL.COST_GOLD, rice: INTEL.COST_RICE });
    expect(run(state).state.generals[1]).toMatchObject({ gold: 0, rice: 0 });
    expect(run(state, { ...actor, tick: TICKS_PER_MONTH * 12 * 20 }).state.generals[1]).toMatchObject({
      gold: 0,
      rice: 0,
    });
  });
  it('X7 조각 누락은 예외이고 RNG를 소비하지 않는다', () => {
    const state = commandWorld();
    const rng = createRng('missing');
    const int = vi.spyOn(rng, 'int');
    expect(() => spy.execute(state, actor, args, rng)).toThrow('intel');
    expect(int).not.toHaveBeenCalled();
  });
});

describe('V9 첩보 조각 검증', () => {
  it.each([
    ['남는 칸', { ...golden(1), extra: 1 }],
    ['음수', { ...golden(1), crew: -1 }],
    ['소수 정수 칸', { ...golden(1), tick: 0.5 }],
    ['안전 정수 초과', { ...golden(1), population: Number.MAX_SAFE_INTEGER + 1 }],
    ['유한하지 않은 민심', { ...golden(1), trust: Infinity }],
    ['민심 상한', { ...golden(1), trust: 100.1 }],
    ['민심 하한', { ...golden(1), trust: -0.1 }],
    ['단계', { ...golden(1), level: 4 }],
    ['국가 남는 칸', { ...golden(1), owner: { ...golden(1).owner, extra: 1 } }],
    ['내정 남는 칸', { ...golden(1), domestic: { ...domestic, extra: 1 } }],
    ['내정 음수', { ...golden(1), domestic: { ...domestic, wall: -1 } }],
    ['병종 음수', { ...golden(1), crewTypes: [{ crewType: -1, generals: 1 }] }],
    [
      '병종 정렬',
      {
        ...golden(1),
        crewTypes: [
          { crewType: 2, generals: 1 },
          { crewType: 1, generals: 1 },
        ],
      },
    ],
    [
      '병종 중복',
      {
        ...golden(1),
        crewTypes: [
          { crewType: 1, generals: 1 },
          { crewType: 1, generals: 1 },
        ],
      },
    ],
    ['기술 값', { ...golden(1), tech: 'unknown' }],
    ['필수 내정 누락', { ...golden(2), domestic: undefined }],
    ['필수 병종 누락', { ...golden(1), crewTypes: undefined }],
    ['필수 기술 누락', { ...golden(1), tech: undefined }],
    ['낮은 단계 내정', { ...golden(3), domestic }],
    ['낮은 단계 병종', { ...golden(2), crewTypes: [] }],
    ['낮은 단계 기술', { ...golden(2), tech: 'even' }],
    ['공백지 기술', { ...golden(1), owner: null }],
    ['undefined 선택 칸', { ...golden(3), tech: undefined }],
  ])('%s 거부', (_name, record) => {
    expect(intelSlice.validate({ '1': { '2': record } })).toBe(false);
  });
  it.each(['0', '-1', '01', '1.5', '10000000000', 'x', '__proto__', 'constructor'])('국가·도시 키 %s 거부', (key) => {
    expect(intelSlice.validate({ [key]: { '2': golden(1) } })).toBe(false);
    expect(intelSlice.validate({ '1': { [key]: golden(1) } })).toBe(false);
  });
  it('최대 키와 안전 정수, 소수 민심, 빈 조각을 받는다', () => {
    expect(
      intelSlice.validate({ '9999999999': { '9999999999': { ...golden(1), tick: Number.MAX_SAFE_INTEGER } } }),
    ).toBe(true);
    expect(intelSlice.validate({})).toBe(true);
    expect(intelSlice.validate(null)).toBe(false);
    expect(intelSlice.validate([])).toBe(false);
  });
});
