import type { Prisma } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import {
  assertNoResidenceAnchors,
  assertNoResidenceAnchorsInRows,
  loadResidenceAnchors,
  persistResidenceAnchors,
} from './residenceState';

type Row = { id: number; userId: string | null; residenceTick: number | null };
type Anchors = Parameters<typeof persistResidenceAnchors>[2];

function fixture(
  rows: Row[] = [
    { id: 1, userId: null, residenceTick: null },
    { id: 3, userId: 'human-3', residenceTick: 5 },
    { id: 4, userId: 'human-4', residenceTick: 10 },
  ],
) {
  const tx = {
    general: {
      findMany: vi.fn().mockResolvedValue(rows),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  return {
    rows,
    tx,
    load: () => loadResidenceAnchors(client, 'world'),
    off: () => assertNoResidenceAnchors(client, 'world'),
    save: (before: Anchors, after: Anchors) => persistResidenceAnchors(client, 'world', before, after),
  };
}

describe('물리 거주 앵커의 비공개 적재', () => {
  it('같은 트랜잭션의 전체 장수 사본에서도 기능 off의 non-null 앵커를 거부한다', () => {
    expect(() => assertNoResidenceAnchorsInRows([{ residenceTick: null }])).not.toThrow();
    expect(() => assertNoResidenceAnchorsInRows([{ residenceTick: null }, { residenceTick: 0 }])).toThrow(
      '인사 기능을 끈 월드',
    );
    expect(() => assertNoResidenceAnchorsInRows([{ residenceTick: 10 }])).toThrow('인사 기능을 끈 월드');
  });
  it('사람만 실제 저장 tick으로 읽고 월드와 조회 필드를 고정한다', async () => {
    const f = fixture();
    expect(await f.load()).toEqual({ 3: 5, 4: 10 });
    expect(f.tx.general.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world' },
      select: { id: true, userId: true, residenceTick: true },
      orderBy: { id: 'asc' },
    });
    expect(f.tx.general.updateMany).not.toHaveBeenCalled();
  });

  it('사람이 없으면 빈 map을 만들고 0도 실제 tick으로 보존한다', async () => {
    expect(await fixture([{ id: 1, userId: null, residenceTick: null }]).load()).toEqual({});
    expect(await fixture([{ id: 3, userId: 'human', residenceTick: 0 }]).load()).toEqual({ 3: 0 });
  });

  it.each([null, -1, 0.5, NaN, 2_147_483_648])(
    '사람의 잘못된 저장 tick %s를 보정하지 않는다',
    async (residenceTick) => {
      await expect(fixture([{ id: 3, userId: 'human', residenceTick }]).load()).rejects.toThrow('사람 장수');
    },
  );

  it.each([0, 10])('NPC의 앵커 %s를 거부한다', async (residenceTick) => {
    await expect(fixture([{ id: 1, userId: null, residenceTick }]).load()).rejects.toThrow('NPC 장수');
  });

  it('기능 off는 사람·NPC 구분 없이 non-null 열을 검사한다', async () => {
    const f = fixture();
    await expect(f.off()).resolves.toBeUndefined();
    expect(f.tx.general.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world', residenceTick: { not: null } },
      select: { id: true },
    });
    f.tx.general.findFirst.mockResolvedValue({ id: 1 });
    await expect(f.off()).rejects.toThrow('인사 기능을 끈 월드');
    expect(f.tx.general.findMany).not.toHaveBeenCalled();
  });
});

describe('같은 트랜잭션의 물리 거주 앵커 저장', () => {
  it('변경 없는 사람과 NPC에는 쓰지 않는다', async () => {
    const f = fixture();
    await f.save({ 3: 5, 4: 10 }, { 3: 5, 4: 10 });
    expect(f.tx.general.updateMany).not.toHaveBeenCalled();
  });

  it('입력105 뒤 턴102의 실제 이동을 이전 tick 조건으로 저장한다', async () => {
    const f = fixture([{ id: 3, userId: 'human', residenceTick: 105 }]);
    await f.save({ 3: 105 }, { 3: 102 });
    expect(f.tx.general.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world', id: 3, userId: 'human', residenceTick: 105 },
      data: { residenceTick: 102 },
    });
  });

  it('새 사람의 null 열에 실제 생성 tick 0을 저장한다', async () => {
    const f = fixture([{ id: 5, userId: 'new-human', residenceTick: null }]);
    await f.save({}, { 5: 0 });
    expect(f.tx.general.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world', id: 5, userId: 'new-human', residenceTick: null },
      data: { residenceTick: 0 },
    });
  });

  it('삭제된 장수에는 쓰지 않고 NPC로 남은 행의 열은 null로 비운다', async () => {
    const deleted = fixture([]);
    await deleted.save({ 3: 10 }, {});
    expect(deleted.tx.general.updateMany).not.toHaveBeenCalled();
    const npc = fixture([{ id: 3, userId: null, residenceTick: 10 }]);
    await npc.save({ 3: 10 }, {});
    expect(npc.tx.general.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world', id: 3, userId: null, residenceTick: 10 },
      data: { residenceTick: null },
    });
  });

  it.each([{}, { 3: 5 }, { 3: 5, 4: 10, 1: 0 }, { 3: 5, 4: 10, 999: 0 }])(
    '최종 사람과 다른 map %j는 쓰기 전에 거부한다',
    async (after) => {
      const f = fixture();
      await expect(f.save({ 3: 5, 4: 10 }, after)).rejects.toThrow('최종 사람 장수');
      expect(f.tx.general.updateMany).not.toHaveBeenCalled();
    },
  );

  it('어떤 행의 시작값이라도 다르면 앞선 행에도 쓰지 않는다', async () => {
    const f = fixture();
    await expect(f.save({ 3: 5, 4: 9 }, { 3: 100, 4: 100 })).rejects.toThrow('시작값');
    expect(f.tx.general.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, [], { '03': 5 }, { 3: -1 }, { 3: 0.5 }, { 3: 2_147_483_648 }, { [Symbol('hidden')]: 0 }])(
    '잘못된 map %j는 DB 조회 전에 거부한다',
    async (invalid) => {
      const f = fixture();
      await expect(f.save(invalid as unknown as Anchors, {})).rejects.toThrow('물리 거주 앵커');
      expect(f.tx.general.findMany).not.toHaveBeenCalled();
      expect(f.tx.general.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([0, 2])('조건 갱신이 %s행이면 호출자 트랜잭션에 실패를 전한다', async (count) => {
    const f = fixture();
    f.tx.general.updateMany.mockResolvedValue({ count });
    await expect(f.save({ 3: 5, 4: 10 }, { 3: 100, 4: 10 })).rejects.toThrow('한 행');
    expect(f.tx.general.updateMany).toHaveBeenCalledOnce();
  });

  it('조회와 갱신 오류를 숨기거나 재시도하지 않는다', async () => {
    const f = fixture();
    const error = new Error('저장 실패');
    f.tx.general.findMany.mockRejectedValueOnce(error);
    await expect(f.load()).rejects.toBe(error);
    f.tx.general.updateMany.mockRejectedValueOnce(error);
    await expect(f.save({ 3: 5, 4: 10 }, { 3: 100, 4: 10 })).rejects.toBe(error);
    expect(f.tx.general.updateMany).toHaveBeenCalledOnce();
  });
});
