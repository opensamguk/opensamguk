import { rngFor } from '@opensamguk/shared';
import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { removeNation } from '../commands/support';
import { runGeneralTurn } from '../index';
import { cloneWorld, cloneWorldWithRegistry } from '../model/clone';
import type { WorldState } from '../model/world';
import { runMonthly } from '../monthly/index';
import {
  applyTreatyInput,
  nextNationTrust,
  settleTreaties,
  treatyBreakRecipients,
  validateBrokenTreatyRow,
  validateNationTrustState,
} from './treaty';
import type { BrokenTreatyRow, FirstTreatyClause, NationTrustState, TreatyBroken, TreatyState } from './treatyTypes';

const maxInt = 2_147_483_647;
const maxTick = 2_147_473_647;
const note: FirstTreatyClause[] = [{ kind: 'note', text: '기록' }];

function brokenRow(npc = false, tick = 1500, clauses = note): BrokenTreatyRow {
  const world = commandWorld();
  world.nations[1]!.isNpc = false;
  world.nations[2]!.isNpc = npc;
  const proposal = applyTreatyInput(
    world,
    { generalId: 1, kind: 'treaty.propose', payload: { toNationId: 2, clauses } },
    { tick, sequence: 10 },
  );
  if (!proposal.ok) throw new Error('제안을 만들지 못했습니다.');
  const accepted = npc
    ? proposal
    : applyTreatyInput(
        proposal.state,
        { generalId: 2, kind: 'treaty.respond', payload: { treatyId: '10', accept: true } },
        { tick: tick + 1, sequence: 11 },
      );
  if (!accepted.ok || accepted.result.outcome !== 'ACCEPTED') throw new Error('수락을 만들지 못했습니다.');
  const active = accepted.state.treaties![0]!;
  expect(active.status).toBe('ACTIVE');
  expect(accepted.result.by).toBe(npc ? 'NPC' : 'HUMAN');
  if (active.startTick === null) throw new Error('수락한 조약의 시작 시각이 없습니다.');
  return {
    ...active,
    status: 'BROKEN',
    startTick: active.startTick,
    costFrom: accepted.result.cost.from,
    costTo: accepted.result.cost.to,
    closedSequence: 20,
  };
}

const trust = (nationId = 1, brokenTreaties = 2, lastBrokenTick = 2000): NationTrustState => ({
  nationId,
  brokenTreaties,
  lastBrokenTick,
});

function trustWorld(): WorldState {
  const world = commandWorld();
  world.generals[1]!.userId = 'human';
  world.nationTrust = [trust()];
  return world;
}

function expectSeparateTrust(next: WorldState, before: WorldState) {
  expect(next.nationTrust).toEqual(before.nationTrust);
  expect(next.nationTrust).not.toBe(before.nationTrust);
  next.nationTrust!.forEach((entry, i) => expect(entry).not.toBe(before.nationTrust![i]));
}

describe('T2-07 / AC-M2-06 A1a R11 파기 이력 검사', () => {
  it.each([
    { npc: false, tick: 1500, clauses: note },
    { npc: true, tick: 1500, clauses: note },
    { npc: true, tick: 2_147_423_647, clauses: note },
    {
      npc: true,
      tick: 2_146_270_000,
      clauses: [{ kind: 'peace' }, { kind: 'nonAggression', months: 120 }] as FirstTreatyClause[],
    },
  ])('실제 수락에서 만든 파기 이력을 검사한다 (%j)', ({ npc, tick, clauses }) => {
    const row = brokenRow(npc, tick, clauses);
    const before = structuredClone(row);
    expect(validateBrokenTreatyRow(row)).toEqual(row);
    expect(row).toEqual(before);
  });

  it('기록 조약의 시작은 엔진 마지막 tick까지, 비용과 순서는 Int 끝까지 저장한다', () => {
    const row = {
      ...brokenRow(true, 2_147_423_647),
      startTick: maxTick,
      costFrom: maxInt,
      costTo: 0,
      closedSequence: maxInt,
    };
    expect(validateBrokenTreatyRow(row)).toEqual(row);
    expect(() => validateBrokenTreatyRow({ ...row, startTick: maxTick + 1 })).toThrow();
  });

  it.each([
    { status: 'ACTIVE' },
    { status: 'ENDED' },
    { status: 'REJECTED' },
    { status: 'EXPIRED' },
    { status: 'PROPOSED' },
    { costFrom: null },
    { costTo: null },
    { costFrom: -1 },
    { costTo: -1 },
    { costFrom: maxInt + 1 },
    { costTo: 0.5 },
    { closedSequence: 10 },
    { closedSequence: 9 },
    { closedSequence: maxInt + 1 },
    { id: 0 },
    { id: maxInt + 1 },
    { fromNationId: 0 },
    { fromNationId: maxInt + 1 },
    { toNationId: 1 },
    { toNationId: maxInt + 1 },
    { proposedTick: -1 },
    { proposedTick: maxTick + 1 },
    { respondByTick: 61_501 },
    { startTick: null },
    { startTick: 1499 },
    { startTick: 61_500 },
    { endTick: 11_501 },
    { clauses: [] },
    { clauses: [{ kind: 'note', text: '기록' }, { kind: 'peace' }] },
    { clauses: [{ kind: 'note', text: '' }] },
    { clauses: [{ kind: 'nonAggression', months: 121 }] },
    { clauses: [{ kind: 'passage', cityKeys: [1] }] },
    { worldId: 'world' },
    { brokenTick: 2000 },
  ])('저장 계약을 벗어난 파기 이력을 거부한다 (%j)', (patch) => {
    expect(() => validateBrokenTreatyRow({ ...brokenRow(), ...patch })).toThrow();
  });

  it('불가침 종료 시각과 마지막 월간 정산 경계를 검사한다', () => {
    const row = brokenRow(true, 2_146_270_000, [{ kind: 'peace' }, { kind: 'nonAggression', months: 120 }]);
    expect(row.endTick).toBe(2_147_470_000);
    expect(() => validateBrokenTreatyRow({ ...row, endTick: null })).toThrow();
    expect(() => validateBrokenTreatyRow({ ...row, endTick: row.endTick! - 1 })).toThrow();
    expect(() =>
      validateBrokenTreatyRow({ ...row, startTick: row.startTick + 1, endTick: row.endTick! + 1 }),
    ).toThrow();
  });

  it.each([undefined, null, [], {}, 1])('12칸 행이 아닌 값을 거부한다 (%j)', (value) => {
    expect(() => validateBrokenTreatyRow(value)).toThrow();
  });
});

describe('T2-07 / AC-M2-06 A1a R12 국가 신의 기록', () => {
  it('없는 기록은 첫 파기 한 번과 tick 0부터 만든다', () => {
    expect(nextNationTrust(undefined, 2, 0)).toEqual([trust(2, 1, 0)]);
  });

  it.each([1, 3, 5])('새 국가는 번호 %i의 정렬 위치에 넣고 입력을 보존한다', (nationId) => {
    const before = Object.freeze([Object.freeze(trust(2)), Object.freeze(trust(4))]);
    const next = nextNationTrust(before, nationId, 2001);
    expect(next).toEqual([trust(2), trust(4), trust(nationId, 1, 2001)].sort((a, b) => a.nationId - b.nationId));
    expect(before).toEqual([trust(2), trust(4)]);
    expect(next.find((entry) => entry.nationId === 2)).not.toBe(before[0]);
  });

  it.each([2000, 2001])('기존 2회를 3회로 늘리고 시각 %i를 기록한다', (tick) => {
    const before = [trust()];
    expect(nextNationTrust(before, 1, tick)).toEqual([trust(1, 3, tick)]);
    expect(before).toEqual([trust()]);
  });

  it('Int와 엔진 tick 끝점을 보존하고 횟수 초과·과거 시각을 거부한다', () => {
    expect(validateNationTrustState([trust(maxInt, maxInt, maxTick)])).toEqual([trust(maxInt, maxInt, maxTick)]);
    expect(nextNationTrust([trust(1, maxInt - 1)], 1, maxTick)).toEqual([trust(1, maxInt, maxTick)]);
    expect(() => nextNationTrust([trust(1, maxInt)], 1, 2000)).toThrow();
    expect(() => nextNationTrust([trust()], 1, 1999)).toThrow();
  });

  it.each([
    undefined,
    null,
    {},
    [],
    [trust(1, 0)],
    [trust(1, -1)],
    [trust(1, maxInt + 1)],
    [trust(1, 1.5)],
    [trust(0)],
    [trust(-1)],
    [trust(maxInt + 1)],
    [trust(1.5)],
    [trust(1, 1, -1)],
    [trust(1, 1, maxTick + 1)],
    [trust(1, 1, 0.5)],
    [trust(1, 1, NaN)],
    [trust(1, Infinity)],
    [trust(), trust()],
    [trust(2), trust(1)],
    [{ ...trust(), extra: 0 }],
    [{ nationId: 1, brokenTreaties: 1 }],
  ])('잘못된 신의 기록을 거부한다 (%j)', (value) => {
    expect(() => validateNationTrustState(value)).toThrow();
  });

  it.each([-1, 0, 0.5, maxInt + 1, NaN, Infinity])('새 국가 번호 %s를 검사한다', (nationId) => {
    expect(() => nextNationTrust(undefined, nationId, 0)).toThrow();
  });

  it.each([-1, 0.5, maxTick + 1, maxInt + 1, NaN, Infinity])('새 파기 tick %s를 검사한다', (tick) => {
    expect(() => nextNationTrust(undefined, 1, tick)).toThrow();
  });

  it('갱신 전에도 정렬·키·횟수 계약을 검사한다', () => {
    expect(() => nextNationTrust([], 1, 2000)).toThrow();
    expect(() => nextNationTrust([trust(2), trust(1)], 1, 2000)).toThrow();
    expect(() => nextNationTrust([trust(1, 0)], 1, 2000)).toThrow();
  });
});

describe('T2-07 / AC-M2-06 A1a R13 신의 상태 보존', () => {
  it.each([cloneWorld, (world: WorldState) => cloneWorldWithRegistry(world, { slices: [], bindings: [] })])(
    '복제한 배열과 원소는 입력에서 분리된다 (%#)',
    (clone) => {
      const world = trustWorld();
      const before = structuredClone(world);
      const next = clone(world);
      expectSeparateTrust(next, world);
      next.nationTrust![0]!.brokenTreaties += 1;
      expect(world).toEqual(before);
    },
  );

  it('기록 없는 월드와 빈 배열은 기존 키와 직렬화 값을 유지한다', () => {
    const world = commandWorld();
    expect(Object.hasOwn(world, 'nationTrust')).toBe(false);
    for (const source of [world, { ...world, nationTrust: [] }]) {
      const next = cloneWorld(source);
      expect(Object.hasOwn(next, 'nationTrust')).toBe(false);
      expect(Object.keys(next)).toEqual(Object.keys(world));
      expect(JSON.stringify(next)).toBe(JSON.stringify(world));
    }
  });

  it('실제 휴식 턴이 부상을 회복하면서 신의 기록을 보존한다', () => {
    const world = trustWorld();
    const before = structuredClone(world);
    const turn = runGeneralTurn(world, { generalId: 1, tick: 2000 }, { commandKey: 'rest', args: {} }, 'trust-rest');
    expect('code' in turn.result).toBe(false);
    expect(turn.state.generals[1]!.injury).toBeLessThan(world.generals[1]!.injury);
    expectSeparateTrust(turn.state, world);
    expect(world).toEqual(before);
  });

  it('실제 명령 실패의 상태 복제도 신의 기록을 보존한다', () => {
    const world = trustWorld();
    world.generals[1]!.gold = 0;
    const before = structuredClone(world);
    const turn = runGeneralTurn(world, { generalId: 1, tick: 2000 }, { commandKey: 'farm', args: {} }, 'trust-fail');
    expect(turn.result).toMatchObject({ code: 'NO_GOLD' });
    expectSeparateTrust(turn.state, world);
    expect(turn.state).toEqual(before);
    expect(world).toEqual(before);
  });

  it('실제 월간 정산과 조약 정산 뒤에도 신의 기록을 보존한다', () => {
    const world = trustWorld();
    const before = structuredClone(world);
    const monthly = runMonthly(world, 10_000, rngFor('trust-month')).state;
    expect(monthly.cities[1]!.population).not.toBe(world.cities[1]!.population);
    expectSeparateTrust(monthly, world);
    expectSeparateTrust(settleTreaties(monthly, 10_000), world);
    expect(world).toEqual(before);
  });

  it('파기 국가를 삭제해도 기록을 남기며 현재 국가 존재를 요구하지 않는다', () => {
    const world = trustWorld();
    removeNation(world, 1);
    expect(world.nations[1]).toBeUndefined();
    expect(world.nationTrust).toEqual([trust()]);
    expect(validateNationTrustState(world.nationTrust)).toEqual([trust()]);
  });
});

describe('T2-07 / AC-M2-06 A1a R14 파기 통지 수신국', () => {
  it.each([false, true])('양 방향 ACTIVE 당사국을 중복 없이 정렬하고 NPC도 포함한다 (NPC %s)', (npc) => {
    const world = commandWorld();
    for (const id of [3, 4, 5, 6]) world.nations[id] = { ...world.nations[2]!, id, isNpc: npc };
    world.nations[2]!.isNpc = npc;
    const active = (id: number, fromNationId: number, toNationId: number): TreatyState => ({
      id,
      fromNationId,
      toNationId,
      clauses: note,
      status: 'ACTIVE',
      proposedTick: 1500,
      respondByTick: 61_500,
      startTick: 1501,
      endTick: null,
    });
    world.treaties = [
      active(3, 3, 1),
      active(1, 1, 2),
      active(2, 1, 3),
      { ...active(4, 1, 4), status: 'PROPOSED', startTick: null },
      active(7, 7, 1),
      active(8, 5, 6),
    ];
    // E의 끝난 조약과 조약 없는 F는 열린 조약 상태에 없다. 삭제된 G도 국가 목록에 없다.
    const before = structuredClone(world);
    const result: TreatyBroken = { outcome: 'BROKEN', tick: 2000, treatyId: '1', brokenByNationId: 1 };
    expect(treatyBreakRecipients(world, result)).toEqual([2, 3]);
    expect(world).toEqual(before);
    expect(result).toEqual({ outcome: 'BROKEN', tick: 2000, treatyId: '1', brokenByNationId: 1 });
  });

  it('열린 조약이 없으면 수신국도 없다', () => {
    expect(
      treatyBreakRecipients(commandWorld(), { outcome: 'BROKEN', tick: 2000, treatyId: '1', brokenByNationId: 1 }),
    ).toEqual([]);
  });
});
