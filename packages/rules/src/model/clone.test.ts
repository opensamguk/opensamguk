import { expect, expectTypeOf, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import type { ExtSlice, ExtStateRegistry } from '../commands/ext/state';
import type {
  AssignmentOffer as PersonnelOffer,
  OfficeRevisions as PersonnelRevisions,
  OfficeTurns as PersonnelTurns,
  OfficeState,
  OfficeView,
  PersonnelState,
  PersonnelView,
} from '../personnel';
import type { OfficeState as PublicOfficeState, OfficeTurns as PublicOfficeTurns } from '../index';
import type { ReplayState } from '../replay';
import type { AssignmentOffer, JsonValue, OfficeRevisions, OfficeTurns, WorldState, WorldView } from './world';
import { cloneWorld, cloneWorldWithRegistry } from './clone';

it('빠른 월드 복제는 structuredClone과 같고 중첩 필드도 분리한다', () => {
  const world = commandWorld();
  world.commandMeta = { nextNationId: 3, offers: { 4: 1 } };
  world.nationTurns = { 1: [{ commandKey: 'nation_rest', args: { nested: [1] } }] };
  const before = structuredClone(world);
  const clone = cloneWorld(world);
  expect(clone).toEqual(before);
  clone.generals[1]!.gold++;
  clone.nations[1]!.gold++;
  clone.cities[1]!.connections.push(4);
  clone.diplomacies[0]!.state = 'DECLARED';
  clone.commandMeta!.offers[4] = 2;
  (clone.nationTurns![1]![0]!.args as { nested: number[] }).nested.push(2);
  expect(world).toEqual(before);
});

const cloners = [
  { name: '기본 복제', clone: cloneWorld },
  {
    name: '빈 registry 복제',
    clone: (view: WorldView) => cloneWorldWithRegistry(view, { slices: [], bindings: [] }),
  },
];
const shapes = ['없음', '빈 루트', '채움'] as const;

function personnelWorld(): WorldState {
  const world = commandWorld();
  world.assignmentOffers = {
    3: { id: '0-1-3', nationId: 1, issuerGeneralId: 1, cityKey: 1, createdTick: 0, expiresTick: 20000 },
    4: { id: '0-1-4', nationId: 1, issuerGeneralId: 1, cityKey: 4, createdTick: 0, expiresTick: 20000 },
  };
  world.officeTurns = {
    1: {
      11: [{ commandKey: 'nation_rest', args: {} }],
      12: [{ commandKey: 'nation_rest', args: { nested: [1, { deep: true }] } }],
    },
    2: { 12: [{ commandKey: 'nation_rest', args: {} }] },
  };
  return world;
}

function nested(value: unknown) {
  if (value === null || typeof value !== 'object' || !('nested' in value) || !Array.isArray(value.nested))
    throw new Error('중첩 배열이 없습니다.');
  return value.nested;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

for (const { name, clone } of cloners) {
  it.each(shapes.flatMap((offers) => shapes.map((turns) => [offers, turns] as const)))(
    `${name}는 인사 두 키의 아홉 조합을 독립적으로 생략하거나 보존한다 (%s·%s)`,
    (offers, turns) => {
      const world = commandWorld();
      const populated = personnelWorld();
      if (offers !== '없음') world.assignmentOffers = offers === '빈 루트' ? {} : populated.assignmentOffers!;
      if (turns !== '없음') world.officeTurns = turns === '빈 루트' ? {} : populated.officeTurns!;
      const result = clone(world);
      expect(Object.hasOwn(result, 'assignmentOffers')).toBe(offers === '채움');
      expect(Object.hasOwn(result, 'officeTurns')).toBe(turns === '채움');
      if (offers === '채움') expect(result.assignmentOffers).toEqual(world.assignmentOffers);
      if (turns === '채움') expect(result.officeTurns).toEqual(world.officeTurns);
      if (offers !== '채움' && turns !== '채움') {
        const legacy = commandWorld();
        expect(Object.keys(result)).toEqual(Object.keys(legacy));
        expect(JSON.stringify(result)).toBe(JSON.stringify(legacy));
      }
    },
  );

  it(`${name}는 발령 행과 직책 칸의 모든 가변 참조를 분리한다`, () => {
    const world = personnelWorld();
    const before = structuredClone(world);
    const result = clone(world);
    expect(result.assignmentOffers).not.toBe(world.assignmentOffers);
    for (const id of Object.keys(world.assignmentOffers!).map(Number))
      expect(result.assignmentOffers![id]).not.toBe(world.assignmentOffers![id]);
    expect(result.officeTurns).not.toBe(world.officeTurns);
    for (const [nation, offices] of Object.entries(world.officeTurns!)) {
      const copied = result.officeTurns![Number(nation)]!;
      expect(copied).not.toBe(offices);
      for (const [level, slots] of Object.entries(offices)) {
        const copiedSlots = copied[Number(level)]!;
        expect(copiedSlots).not.toBe(slots);
        for (const [i, slot] of slots.entries()) {
          expect(copiedSlots[i]).not.toBe(slot);
          expect(copiedSlots[i]!.args).not.toBe(slot.args);
        }
      }
    }
    const resultArgs = result.officeTurns![1]![12]![0]!.args;
    expect(nested(resultArgs)).not.toBe(nested(world.officeTurns![1]![12]![0]!.args));
    expect(nested(resultArgs)[1]).not.toBe(nested(world.officeTurns![1]![12]![0]!.args)[1]);
    result.assignmentOffers![3]!.expiresTick++;
    delete result.assignmentOffers![4];
    nested(resultArgs).push(2);
    nested(resultArgs)[1].deep = false;
    result.officeTurns![1]![12]![0]!.commandKey = 'nation_seize';
    result.officeTurns![1]![12]!.push({ commandKey: 'nation_rest', args: {} });
    result.officeTurns![2]![11] = [];
    expect(world).toEqual(before);
  });

  it(`${name}는 unknown args의 음수 0과 undefined 자기 키를 보존한다`, () => {
    const world = personnelWorld();
    const original = { zero: -0, gone: undefined, nested: [1, { deep: true }] };
    world.officeTurns![1]![12]![0]!.args = original;
    const args = clone(world).officeTurns![1]![12]![0]!.args;
    if (args === null || typeof args !== 'object' || !('zero' in args)) throw new Error('인자가 없습니다.');
    expect(Object.is(args.zero, -0)).toBe(true);
    expect(Object.hasOwn(args, 'gone')).toBe(true);
    expect(args).toEqual(original);
    expect(args).not.toBe(original);
  });

  const nestedEmpty: OfficeTurns[] = [
    { 1: {} },
    { 1: { 12: [] } },
    { 1: { 12: [{ commandKey: 'nation_rest', args: {} }] } },
  ];
  it.each(nestedEmpty)(`${name}는 중첩 빈 국가·직책·args를 지우지 않는다 (%j)`, (turns) => {
    const world = commandWorld();
    world.officeTurns = turns;
    const result = clone(world);
    expect(Object.hasOwn(result, 'officeTurns')).toBe(true);
    expect(result.officeTurns).toEqual(turns);
    expect(result.officeTurns).not.toBe(turns);
  });
}

it('시험 registry의 확장·조약·프리셋과 인사 상태를 얼린 입력에서 함께 복제한다', () => {
  const world = personnelWorld();
  world.ext = { test: { nested: [1] } };
  world.presetRules = {
    protection: { foundUntilMonths: 12, peaceMonths: 24, maxGeneralsPerNation: null },
    npc: { aggression: 0.5 },
    boost: { smallWorld: [{ below: 300, multiplier: 1.2 }], lateJoin: null },
  };
  world.treaties = [
    {
      id: 1,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'note', text: '기록' }],
      status: 'ACTIVE',
      proposedTick: 0,
      respondByTick: 60000,
      startTick: 1,
      endTick: null,
    },
  ];
  world.commandMeta = { nextNationId: 3, offers: { 4: 1 } };
  world.nationTurns = {};
  const slice: ExtSlice = {
    key: 'test',
    create: () => ({ nested: [1] }),
    clone: (value) => ({ nested: [...nested(value)] }),
    validate: (value): value is JsonValue =>
      value !== null && typeof value === 'object' && 'nested' in value && Array.isArray(value.nested),
  };
  const registry: ExtStateRegistry = { slices: [slice], bindings: [] };
  const before = structuredClone(world);
  const result = cloneWorldWithRegistry(freeze(world), registry);
  expect(result).toEqual(before);
  expect(result.presetRules).not.toBe(world.presetRules);
  expect(result.treaties![0]!.clauses[0]).not.toBe(world.treaties![0]!.clauses[0]);
  nested(result.ext!.test).push(2);
  result.presetRules!.boost.smallWorld![0]!.multiplier = 2;
  const clause = result.treaties![0]!.clauses[0]!;
  if (clause.kind !== 'note') throw new Error('기록 조항이 없습니다.');
  clause.text = '수정';
  result.commandMeta!.offers[4] = 2;
  result.nationTurns![1] = [];
  result.assignmentOffers![3]!.cityKey = 4;
  nested(result.officeTurns![1]![12]![0]!.args).push(3);
  expect(world).toEqual(before);
  expect(cloneWorldWithRegistry({ ...before, treaties: [] }, registry)).not.toHaveProperty('treaties');
  expect(() => cloneWorld(before)).toThrow();
});

it('기존 인사 타입과 공개 타입은 canonical 모델의 같은 선언으로 이어진다', () => {
  expectTypeOf<PersonnelState>().toEqualTypeOf<WorldState>();
  expectTypeOf<OfficeState>().toEqualTypeOf<WorldState>();
  expectTypeOf<PersonnelView>().toEqualTypeOf<WorldView>();
  expectTypeOf<OfficeView>().toEqualTypeOf<WorldView>();
  expectTypeOf<PersonnelOffer>().toEqualTypeOf<AssignmentOffer>();
  expectTypeOf<PersonnelTurns>().toEqualTypeOf<OfficeTurns>();
  expectTypeOf<PersonnelRevisions>().toEqualTypeOf<OfficeRevisions>();
  expectTypeOf<PublicOfficeState>().toEqualTypeOf<WorldState>();
  expectTypeOf<PublicOfficeTurns>().toEqualTypeOf<OfficeTurns>();
  expectTypeOf<ReplayState['offices']>().toEqualTypeOf<OfficeRevisions | undefined>();
});
