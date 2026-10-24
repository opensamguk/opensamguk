import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '@opensamguk/db';
import type { OfficeTurns } from '@opensamguk/rules';
import { assertNoOfficeRows, loadOfficeState, persistOfficeState } from './personnelState';

const worldId = 'office-codec-unit-world';
const officeRow = { worldId, nationId: 1, officerLevel: 12, turnRevision: 7, tenure: 3 };
const turnRow = { worldId, nationId: 1, officerLevel: 12, slot: 4, commandKey: 'nation_train', args: { amount: 2 } };
const empty = { offices: {} };

function queue(first: OfficeTurns[number][number][number] = { commandKey: 'nation_rest', args: {} }) {
  return Array.from({ length: 12 }, (_, index) =>
    index === 0 ? structuredClone(first) : { commandKey: 'nation_rest', args: {} },
  );
}

function harness() {
  // 모든 질의는 아래 spy가 받는다. 실제 접속을 요청하면 시험이 실패한다.
  const db = createDb('postgresql://office_unit:unused@127.0.0.1:1/never_connect');
  const connect = vi.spyOn(db, '$connect').mockRejectedValue(new Error('단위 시험에서 DB에 접속했습니다.'));
  const transaction = vi.spyOn(db, '$transaction').mockRejectedValue(new Error('별도 트랜잭션을 열었습니다.'));
  return {
    db,
    connect,
    transaction,
    officeRows: vi.spyOn(db.nationOffice, 'findMany').mockResolvedValue([]),
    turnRows: vi.spyOn(db.nationOfficeTurn, 'findMany').mockResolvedValue([]),
    officeFirst: vi.spyOn(db.nationOffice, 'findFirst').mockResolvedValue(null),
    turnFirst: vi.spyOn(db.nationOfficeTurn, 'findFirst').mockResolvedValue(null),
    create: vi.spyOn(db.nationOffice, 'create').mockResolvedValue(officeRow),
    update: vi.spyOn(db.nationOffice, 'updateMany').mockResolvedValue({ count: 1 }),
    remove: vi.spyOn(db.nationOffice, 'deleteMany').mockResolvedValue({ count: 1 }),
    removeTurns: vi.spyOn(db.nationOfficeTurn, 'deleteMany').mockResolvedValue({ count: 12 }),
    insertTurns: vi.spyOn(db, '$executeRaw').mockResolvedValue(12),
    legacy: vi.spyOn(db.nationTurn, 'findMany').mockRejectedValue(new Error('기존 국가 예턴에 접근했습니다.')),
    offers: vi.spyOn(db.assignmentOffer, 'findMany').mockRejectedValue(new Error('발령 제안에 접근했습니다.')),
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.transaction).not.toHaveBeenCalled();
  expect(h.legacy).not.toHaveBeenCalled();
  expect(h.offers).not.toHaveBeenCalled();
  await h.db.$disconnect();
  vi.restoreAllMocks();
});

function expectNoWrites() {
  for (const spy of [h.create, h.update, h.remove, h.removeTurns, h.insertTurns]) expect(spy).not.toHaveBeenCalled();
}

describe('직책 두 표 적재', () => {
  it('두 표가 비면 officeTurns 키를 생략한다', async () => {
    expect(await loadOfficeState(h.db, worldId)).toEqual(empty);
    expect(h.officeRows).toHaveBeenCalledWith({
      where: { worldId },
      orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }],
    });
    expect(h.turnRows).toHaveBeenCalledWith({
      where: { worldId },
      orderBy: [{ nationId: 'asc' }, { officerLevel: 'asc' }, { slot: 'asc' }],
    });
    expectNoWrites();
  });

  it('직책 행만 있으면 수치를 보존하고 예턴 키를 만들지 않는다', async () => {
    h.officeRows.mockResolvedValue([officeRow]);
    expect(await loadOfficeState(h.db, worldId)).toEqual({ offices: { 1: { 12: { revision: 7, tenure: 3 } } } });
  });

  it('국가·직책마다 빠진 칸을 독립된 휴식으로 채운다', async () => {
    h.officeRows.mockResolvedValue([officeRow]);
    h.turnRows.mockResolvedValue([
      turnRow,
      { ...turnRow, officerLevel: 5, slot: 0 },
      { ...turnRow, nationId: 2, slot: 11 },
    ]);
    const loaded = await loadOfficeState(h.db, worldId);
    const turns = loaded.officeTurns!;
    expect(loaded.offices).toEqual({ 1: { 12: { revision: 7, tenure: 3 } } });
    for (const slots of [turns[1]![12]!, turns[1]![5]!, turns[2]![12]!]) expect(slots).toHaveLength(12);
    expect(turns[1]![12]![4]).toEqual({ commandKey: turnRow.commandKey, args: turnRow.args });
    expect(turns[1]![12]![0]).toEqual({ commandKey: 'nation_rest', args: {} });
    expect(turns[1]![12]![0]!.args).not.toBe(turns[1]![12]![1]!.args);
    expect(turns[1]![12]![4]!.args).not.toBe(turnRow.args);
    expect(loaded.offices[2]?.[12] ?? { revision: 0, tenure: 0 }).toEqual({ revision: 0, tenure: 0 });
  });

  it.each([-1, 12])('범위를 벗어난 저장 칸 %s를 거부한다', async (slot) => {
    h.turnRows.mockResolvedValue([{ ...turnRow, slot }]);
    await expect(loadOfficeState(h.db, worldId)).rejects.toThrow('칸 번호');
    expectNoWrites();
  });
});

describe('직책 두 표 꺼짐 검사', () => {
  it('두 표가 비면 읽기만 한다', async () => {
    await assertNoOfficeRows(h.db, worldId);
    for (const spy of [h.officeFirst, h.turnFirst])
      expect(spy).toHaveBeenCalledWith({ where: { worldId }, select: { nationId: true } });
    expectNoWrites();
  });

  it.each(['office', 'turn'] as const)('%s 행이 하나라도 있으면 거부한다', async (table) => {
    if (table === 'office') h.officeFirst.mockResolvedValue(officeRow);
    else h.turnFirst.mockResolvedValue(turnRow);
    await expect(assertNoOfficeRows(h.db, worldId)).rejects.toThrow('직책 저장 행');
    expectNoWrites();
  });
});

describe('직책 두 표 차이 저장', () => {
  it('빈 상태와 JSON 키 순서만 달라진 상태는 쓰지 않는다', async () => {
    await persistOfficeState(h.db, worldId, empty, empty);
    await persistOfficeState(
      h.db,
      worldId,
      {
        offices: { 1: { 12: { revision: 7, tenure: 3 } } },
        officeTurns: { 1: { 12: queue({ commandKey: 'x', args: { a: 1, b: 2 } }) } },
      },
      {
        offices: { 1: { 12: { tenure: 3, revision: 7 } } },
        officeTurns: { 1: { 12: queue({ commandKey: 'x', args: { b: 2, a: 1 } }) } },
      },
    );
    expectNoWrites();
  });

  it('바뀐 한 직책만 교체하고 최종 수치를 더하지 않고 저장한다', async () => {
    const before = {
      offices: {
        1: { 12: { revision: 7, tenure: 3 }, 5: { revision: 2, tenure: 1 } },
        2: { 12: { revision: 4, tenure: 2 } },
      },
      officeTurns: { 1: { 12: queue(), 5: queue() }, 2: { 12: queue() } },
    };
    const next = structuredClone(before);
    next.offices[1][12] = { revision: 10, tenure: 4 };
    next.officeTurns[1][12] = queue({ commandKey: 'x', args: { a: [null, '값', 3] } });
    const original = structuredClone({ before, next });
    await persistOfficeState(h.db, worldId, before, next);
    expect(h.update).toHaveBeenCalledExactlyOnceWith({
      where: { worldId, nationId: 1, officerLevel: 12, turnRevision: 7, tenure: 3 },
      data: { turnRevision: 10, tenure: 4 },
    });
    expect(h.removeTurns).toHaveBeenCalledExactlyOnceWith({ where: { worldId, nationId: 1, officerLevel: 12 } });
    expect(h.insertTurns).toHaveBeenCalledTimes(1);
    expect(h.insertTurns.mock.calls[0]!.slice(1)).toEqual([worldId, 1, 12, JSON.stringify(next.officeTurns[1][12])]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect({ before, next }).toEqual(original);
  });

  it('직책 수치만 달라지면 예턴을 교체하지 않는다', async () => {
    await persistOfficeState(
      h.db,
      worldId,
      { offices: { 1: { 12: { revision: 7, tenure: 3 } } } },
      { offices: { 1: { 12: { revision: 8, tenure: 3 } } } },
    );
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.removeTurns).not.toHaveBeenCalled();
    expect(h.insertTurns).not.toHaveBeenCalled();
  });

  it('예턴만 달라져도 기존 직책 수치를 조건으로 검사한다', async () => {
    const offices = { 1: { 12: { revision: 7, tenure: 3 } } };
    await persistOfficeState(
      h.db,
      worldId,
      { offices, officeTurns: { 1: { 12: queue() } } },
      { offices, officeTurns: { 1: { 12: queue({ commandKey: 'x', args: null }) } } },
    );
    expect(h.update.mock.calls[0]![0]!.data).toEqual({ turnRevision: 7, tenure: 3 });
    expect(h.insertTurns.mock.calls[0]!.slice(1)).toEqual([
      worldId,
      1,
      12,
      JSON.stringify(queue({ commandKey: 'x', args: null })),
    ]);
  });

  it('처음 쓰는 직책은 호출자의 수치로 만든다', async () => {
    await persistOfficeState(h.db, worldId, empty, {
      offices: { 3: { 5: { revision: 2, tenure: 1 } } },
      officeTurns: { 3: { 5: queue() } },
    });
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      data: { worldId, nationId: 3, officerLevel: 5, turnRevision: 2, tenure: 1 },
    });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insertTurns).toHaveBeenCalledTimes(1);
  });

  it('직책 행이 없는 예턴도 독립적으로 교체한다', async () => {
    await persistOfficeState(h.db, worldId, empty, { offices: {}, officeTurns: { 1: { 5: queue() } } });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insertTurns).toHaveBeenCalledTimes(1);
  });

  it('사라진 직책과 예턴은 그 직책만 지운다', async () => {
    await persistOfficeState(
      h.db,
      worldId,
      { offices: { 1: { 12: { revision: 7, tenure: 3 } } }, officeTurns: { 1: { 12: queue() } } },
      empty,
    );
    expect(h.remove).toHaveBeenCalledExactlyOnceWith({
      where: { worldId, nationId: 1, officerLevel: 12, turnRevision: 7, tenure: 3 },
    });
    expect(h.removeTurns).toHaveBeenCalledExactlyOnceWith({ where: { worldId, nationId: 1, officerLevel: 12 } });
    expect(h.insertTurns).not.toHaveBeenCalled();
  });

  it.each(['update', 'remove'] as const)('%s 조건에 맞는 행이 없으면 다음 쓰기를 중단한다', async (operation) => {
    h[operation].mockResolvedValue({ count: 0 });
    const before = { offices: { 1: { 12: { revision: 7, tenure: 3 } } }, officeTurns: { 1: { 12: queue() } } };
    const next = operation === 'remove' ? empty : { offices: { 1: { 12: { revision: 8, tenure: 3 } } } };
    await expect(persistOfficeState(h.db, worldId, before, next)).rejects.toThrow('바뀌었습니다');
    expect(h.removeTurns).not.toHaveBeenCalled();
    expect(h.insertTurns).not.toHaveBeenCalled();
  });

  it('첫 직책 생성 충돌을 그대로 전달하고 예턴은 쓰지 않는다', async () => {
    h.create.mockRejectedValue(new Error('unique conflict'));
    await expect(
      persistOfficeState(h.db, worldId, empty, {
        offices: { 1: { 5: { revision: 1, tenure: 1 } } },
        officeTurns: { 1: { 5: queue() } },
      }),
    ).rejects.toThrow('unique conflict');
    expect(h.removeTurns).not.toHaveBeenCalled();
  });

  it('12칸 저장 실패를 호출자에게 전달해 트랜잭션을 되돌리게 한다', async () => {
    h.insertTurns.mockResolvedValue(11);
    await expect(
      persistOfficeState(h.db, worldId, empty, { offices: {}, officeTurns: { 1: { 5: queue() } } }),
    ).rejects.toThrow('12칸을 저장하지 못했습니다');
  });

  it('뒤 직책의 잘못된 칸도 앞 직책을 쓰기 전에 검사한다', async () => {
    await expect(
      persistOfficeState(h.db, worldId, empty, {
        offices: { 1: { 5: { revision: 1, tenure: 1 } } },
        officeTurns: { 1: { 5: queue() }, 2: { 12: queue().slice(1) } },
      }),
    ).rejects.toThrow('12칸이어야');
    expectNoWrites();
  });

  it('before가 잘못돼도 저장하지 않는다', async () => {
    await expect(
      persistOfficeState(h.db, worldId, { offices: { 1: { 5: { revision: -1, tenure: 0 } } } }, empty),
    ).rejects.toThrow('revision');
    expectNoWrites();
  });

  it.each([
    { offices: { 0: { 5: { revision: 0, tenure: 0 } } } },
    { offices: { 1: { 4: { revision: 0, tenure: 0 } } } },
    { offices: { 1: { 13: { revision: 0, tenure: 0 } } } },
    { offices: { '01': { 5: { revision: 0, tenure: 0 } } } },
    { offices: { 1: { 5: { revision: -1, tenure: 0 } } } },
    { offices: { 1: { 5: { revision: 0, tenure: 2_147_483_648 } } } },
    { offices: {}, officeTurns: { 1: { 5: queue().slice(1) } } },
    { offices: {}, officeTurns: { 1: { 5: queue({ commandKey: 'x', args: undefined }) } } },
    { offices: {}, officeTurns: { 1: { 5: queue({ commandKey: 'x', args: Number.NaN }) } } },
    { offices: {}, officeTurns: { 1: { 5: queue({ commandKey: 'x', args: new Date(0) }) } } },
  ])('잘못된 상태를 쓰기 전에 거부한다 %#', async (next) => {
    await expect(persistOfficeState(h.db, worldId, empty, next)).rejects.toThrow();
    expectNoWrites();
  });
});
