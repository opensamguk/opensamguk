import type { Prisma } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { shiftTurns } from './persist';

const world = { replayFormat: 3, ruleFeatures: ['policy'], policyFromSequence: 0, actionSequence: 1 };
const queue = () =>
  Array.from({ length: 30 }, (_, slot) => ({
    worldId: 'world',
    generalId: 7,
    slot,
    commandKey: slot === 1 ? 'move' : 'rest',
    args: slot === 1 ? { cityKey: 2 } : {},
    explicit: slot === 1,
  }));
function fixture() {
  const tx = {
    world: { findUniqueOrThrow: vi.fn().mockResolvedValue(world) },
    generalTurn: {
      findMany: vi.fn().mockResolvedValue(queue()),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}
describe('AC-INT-01 잠근 장수의 예턴 사본 재사용', () => {
  it('명령 실행 전 사본의 30칸을 한 번 이동하고 뒤 빈칸은 명시하지 않는다', async () => {
    const f = fixture(),
      slots = queue(),
      before = structuredClone(slots);
    await shiftTurns(f.client, 'world', 7, world, slots);
    expect(f.tx.generalTurn.findMany).not.toHaveBeenCalled();
    expect(f.tx.world.findUniqueOrThrow).not.toHaveBeenCalled();
    const data = f.tx.generalTurn.createMany.mock.calls[0]![0].data;
    expect(data).toHaveLength(30);
    expect(data[0]).toEqual({ ...before[1], slot: 0 });
    expect(data[29]).toEqual({
      worldId: 'world',
      generalId: 7,
      slot: 29,
      commandKey: 'rest',
      args: {},
      explicit: false,
    });
    expect(slots).toEqual(before);
  });
  it.each(['world', 'general', 'missing'] as const)(
    '다른 소유 또는 누락 사본 %s는 쓰기 전에 거부한다',
    async (kind) => {
      const f = fixture(),
        slots = queue();
      if (kind === 'world') slots[0]!.worldId = 'other';
      else if (kind === 'general') slots[0]!.generalId = 8;
      else slots.pop();
      await expect(shiftTurns(f.client, 'world', 7, world, slots)).rejects.toThrow();
      expect(f.tx.generalTurn.deleteMany).not.toHaveBeenCalled();
      expect(f.tx.generalTurn.createMany).not.toHaveBeenCalled();
    },
  );
  it('사본을 받지 않은 호출은 현재 DB에서 월드와 예턴을 읽는다', async () => {
    const f = fixture();
    await shiftTurns(f.client, 'world', 7);
    expect(f.tx.generalTurn.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world', generalId: 7 },
      orderBy: { slot: 'asc' },
    });
    expect(f.tx.world.findUniqueOrThrow).toHaveBeenCalledOnce();
    expect(f.tx.generalTurn.createMany).toHaveBeenCalledOnce();
  });
});
