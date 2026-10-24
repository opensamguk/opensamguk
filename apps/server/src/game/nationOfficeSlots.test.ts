import type { Prisma } from '@opensamguk/db';
import type { QueuedTurn } from '@opensamguk/rules';
import { describe, expect, it, vi } from 'vitest';
import { saveNationOfficeTurns } from './nationOfficeSlots';

function fixture() {
  const world = {
    id: 'world',
    status: 'RUNNING',
    replayFormat: 3,
    ruleFeatures: ['personnel', 'policy'],
    clockTick: 100,
    preset: null,
    replayOrigin: null,
  };
  const actor = { id: 1, nationId: 1 as number | null, officerLevel: 5, lastActiveTick: 105, residenceTick: 105 };
  const office = { turnRevision: 4, tenure: 2 };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    world: { findUnique: vi.fn(async () => world), update: vi.fn(async () => ({ actionSequence: 20 })) },
    general: { findUnique: vi.fn(async () => actor), update: vi.fn(async () => ({})) },
    nationOffice: {
      findUnique: vi.fn(async () => office),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({})),
    },
    nationOfficeTurn: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
    inputEvent: { create: vi.fn(async () => ({ createdAt: new Date(1000) })) },
  };
  const input = { worldId: 'world', userId: 'user', office: { nationId: 1, officerLevel: 5, tenure: 2 }, revision: 4 };
  const change = vi.fn((old: QueuedTurn[]) => old);
  const save = () => saveNationOfficeTurns(tx as unknown as Prisma.TransactionClient, input, change);
  return { world, actor, office, tx, input, change, save };
}
describe('자기 직책 칸의 B7 직접 저장', () => {
  it('잠근 시계100은 자기 기록 tick·activeTick이고 기존 활동과 물리 앵커105는 보존한다', async () => {
    const f = fixture();
    expect(await f.save()).toMatchObject({
      ok: true,
      revision: 5,
      slots: expect.arrayContaining([{ commandKey: 'nation_rest', args: {}, name: '휴식' }]),
    });
    expect(f.tx.inputEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generalId: 1,
        kind: 'nationTurns.set',
        tick: 100,
        sequence: 20,
        result: { revision: 5, activeTick: 100 },
        payload: {
          office: f.input.office,
          revision: 4,
          turns: Array.from({ length: 12 }, () => ({ commandKey: 'nation_rest', args: {} })),
        },
      }),
    });
    expect(f.tx.general.update).toHaveBeenCalledExactlyOnceWith({
      where: { worldId_id: { worldId: 'world', id: 1 } },
      data: { lastActiveTick: 105, lastActiveAt: new Date(1000) },
    });
    expect(f.actor.residenceTick).toBe(105);
    expect(f.tx.world.update).toHaveBeenCalledOnce();
    expect(f.tx.nationOffice.updateMany).toHaveBeenCalledWith({
      where: { worldId: 'world', nationId: 1, officerLevel: 5, turnRevision: 4, tenure: 2 },
      data: { turnRevision: 5 },
    });
  });
  it('정책 off는 직접 tick만 기록하고 활동을 쓰지 않는다', async () => {
    const f = fixture();
    f.world.ruleFeatures = ['personnel'];
    await f.save();
    expect(f.tx.inputEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tick: 100, result: { revision: 5 } }),
    });
    expect(f.tx.general.update).not.toHaveBeenCalled();
  });
  it('STALE은 같은 스냅샷의 12칸을 반환하고 기록·활동·순서를 쓰지 않는다', async () => {
    const f = fixture();
    f.office.turnRevision = 5;
    expect(await f.save()).toMatchObject({ ok: false, reason: 'STALE', revision: 5, slots: expect.any(Array) });
    expect(f.tx.nationOfficeTurn.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.world.update).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.general.update).not.toHaveBeenCalled();
  });
  it.each(['nationId', 'officerLevel', 'tenure'] as const)('현재 %s와 다른 초안은 쓰기 전에 거부한다', async (key) => {
    const f = fixture();
    f.input.office[key]++;
    await expect(f.save()).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(f.tx.nationOfficeTurn.findMany).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it.each([0, 1])('직책 %i는 칸과 활동에 접근하지 않는다', async (level) => {
    const f = fixture();
    f.actor.officerLevel = level;
    await expect(f.save()).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(f.tx.nationOffice.findUnique).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it('다른 권한의 명령·개인 명령·틀린 인자는 저장하지 않는다', async () => {
    for (const turn of [
      { commandKey: 'nation_declare', args: { nationId: 2 } },
      { commandKey: 'rest', args: {} },
      { commandKey: 'nation_rest', args: { extra: true } },
    ]) {
      const f = fixture();
      f.change.mockImplementation((old) => [turn, ...old.slice(1)]);
      await expect(f.save()).rejects.toHaveProperty('code', 'BAD_REQUEST');
      expect(f.tx.nationOffice.updateMany).not.toHaveBeenCalled();
      expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    }
  });
  it('직책 CAS 실패는 기록·활동을 남기지 않는다', async () => {
    const f = fixture();
    f.tx.nationOffice.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.save()).rejects.toThrow('직책 칸이 변경');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.general.update).not.toHaveBeenCalled();
  });
});
