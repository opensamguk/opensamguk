import { expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { runGeneralTurn, type TreatyState, type WorldState } from '../index';
import { cloneWorld, cloneWorldWithRegistry } from './clone';

function treatyWorld(): WorldState {
  const world = commandWorld();
  world.generals[1]!.userId = 'human';
  const treaties: TreatyState[] = [
    {
      id: 1,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 1 }],
      status: 'ACTIVE',
      proposedTick: 500,
      respondByTick: 60_500,
      startTick: 1500,
      endTick: 11_500,
    },
    {
      id: 2,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'note', text: '기록' }],
      status: 'ACTIVE',
      proposedTick: 500,
      respondByTick: 60_500,
      startTick: 1500,
      endTick: null,
    },
    {
      id: 3,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'peace' }],
      status: 'PROPOSED',
      proposedTick: 1500,
      respondByTick: 61_500,
      startTick: null,
      endTick: null,
    },
  ];
  world.treaties = treaties;
  return world;
}

function expectSeparateTreaties(next: WorldState, before: WorldState) {
  expect(next.treaties).toEqual(before.treaties);
  expect(next.treaties).not.toBe(before.treaties);
  for (const [i, treaty] of next.treaties!.entries()) {
    expect(treaty).not.toBe(before.treaties![i]);
    expect(treaty.clauses).not.toBe(before.treaties![i]!.clauses);
    for (const [j, clause] of treaty.clauses.entries()) {
      expect(clause).not.toBe(before.treaties![i]!.clauses[j]);
    }
  }
}

it('조약 없는 월드의 복제는 기본 키와 직렬화 값을 유지한다', () => {
  const world = commandWorld();
  const next = cloneWorld(world);
  expect(Object.hasOwn(world, 'treaties')).toBe(false);
  expect(Object.keys(next)).toEqual(Object.keys(world));
  expect(JSON.stringify(next)).toBe(JSON.stringify(world));
  expect(Object.hasOwn(next, 'treaties')).toBe(false);
  const empty = cloneWorld({ ...world, treaties: [] });
  expect(Object.hasOwn(empty, 'treaties')).toBe(false);
  expect(JSON.stringify(empty)).toBe(JSON.stringify(world));
});

it.each([cloneWorld, (world: WorldState) => cloneWorldWithRegistry(world, { slices: [], bindings: [] })])(
  '조약 복제는 registry와 무관하게 ACTIVE와 null 기한, 중첩 조항을 분리한다 (%#)',
  (clone) => {
    const world = treatyWorld();
    const before = structuredClone(world);
    const next = clone(world);
    expectSeparateTreaties(next, world);
    next.treaties![0]!.endTick = 20_000;
    next.treaties![0]!.clauses[1] = { kind: 'nonAggression', months: 2 };
    const note = next.treaties![1]!.clauses[0]!;
    if (note.kind !== 'note') throw new Error('기록 조항이 없습니다.');
    note.text = '수정';
    next.treaties![2]!.clauses.push({ kind: 'note', text: '추가' });
    next.treaties!.push({ ...next.treaties![2]!, id: 4 });
    expect(world).toEqual(before);
  },
);

it('실제 휴식 턴은 부상을 회복하고 조약을 복제해 보존한다', () => {
  const world = treatyWorld();
  const before = structuredClone(world);
  const turn = runGeneralTurn(world, { generalId: 1, tick: 2000 }, { commandKey: 'rest', args: {} }, 'treaty-clone');
  expect(turn.commandKey).toBe('rest');
  expect('code' in turn.result).toBe(false);
  expect(turn.state.generals[1]!.injury).toBeLessThan(world.generals[1]!.injury);
  expectSeparateTreaties(turn.state, world);
  expect(world).toEqual(before);
});

it('실패한 실제 명령도 효과 없는 복제 경로에서 조약을 보존한다', () => {
  const world = treatyWorld();
  world.generals[1]!.gold = 0;
  const before = structuredClone(world);
  const turn = runGeneralTurn(world, { generalId: 1, tick: 2000 }, { commandKey: 'farm', args: {} }, 'treaty-clone');
  expect(turn.result).toMatchObject({ code: 'NO_GOLD' });
  expect(turn.state).toEqual(before);
  expectSeparateTreaties(turn.state, world);
  expect(world).toEqual(before);
});

it('기본 방침의 실패 뒤 휴식도 조약과 사람 장수 연결을 보존한다', () => {
  const world = treatyWorld();
  world.generals[1]!.gold = 0;
  const before = structuredClone(world);
  const turn = runGeneralTurn(
    world,
    { generalId: 1, tick: 2000 },
    { commandKey: 'rest', args: {}, explicit: false },
    'treaty-clone',
    { policy: 'farm' },
  );
  expect(turn.commandKey).toBe('rest');
  if ('code' in turn.result) throw new Error('방침 휴식이 실패했습니다.');
  expect(turn.result.logs[0]?.text).toBe('기본 방침 실패: 금이 부족합니다. → 휴식');
  expect(turn.state.generals[1]!.injury).toBeLessThan(world.generals[1]!.injury);
  expect(turn.state.generals[1]!.userId).toBe('human');
  expectSeparateTreaties(turn.state, world);
  expect(world).toEqual(before);
});
