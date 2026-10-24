import type { Prisma } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { assertPersonnelStorage } from './personnelState';

function fixture() {
  const tx = {
    nationOffice: { findFirst: vi.fn().mockResolvedValue(null) },
    nationOfficeTurn: { findFirst: vi.fn().mockResolvedValue(null) },
    assignmentOffer: { findFirst: vi.fn().mockResolvedValue(null) },
    nationTurn: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  return {
    tx,
    check: (enabled: boolean) => assertPersonnelStorage(tx as unknown as Prisma.TransactionClient, 'world', enabled),
  };
}

describe('인사 기능 선택과 네 표의 저장 경계', () => {
  it('기능을 끄면 직책·직책 칸·모든 발령 상태를 검사하고 기존 국가 예턴은 허용한다', async () => {
    const f = fixture();
    f.tx.nationTurn.findFirst.mockResolvedValue({ nationId: 1 });
    await expect(f.check(false)).resolves.toBeUndefined();
    for (const table of [f.tx.nationOffice, f.tx.nationOfficeTurn])
      expect(table.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: { worldId: 'world' },
        select: { nationId: true },
      });
    expect(f.tx.assignmentOffer.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world' },
      select: { id: true },
    });
    expect(f.tx.nationTurn.findFirst).not.toHaveBeenCalled();
  });

  it.each(['nationOffice', 'nationOfficeTurn', 'assignmentOffer'] as const)(
    '기능을 끈 월드의 %s 행을 거부한다',
    async (table) => {
      const f = fixture();
      f.tx[table].findFirst.mockResolvedValue({ id: 'closed-offer', nationId: 1 });
      await expect(f.check(false)).rejects.toThrow('인사 저장 행');
    },
  );

  it('기능을 켜면 기존 국가 예턴을 검사하고 인사 표를 비우도록 요구하지 않는다', async () => {
    const f = fixture();
    for (const table of [f.tx.nationOffice, f.tx.nationOfficeTurn, f.tx.assignmentOffer])
      table.findFirst.mockRejectedValue(new Error('인사 표를 꺼진 기능처럼 검사했습니다.'));
    await expect(f.check(true)).resolves.toBeUndefined();
    expect(f.tx.nationTurn.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { worldId: 'world' },
      select: { nationId: true },
    });
    for (const table of [f.tx.nationOffice, f.tx.nationOfficeTurn, f.tx.assignmentOffer])
      expect(table.findFirst).not.toHaveBeenCalled();
  });

  it('기능을 켠 월드에 남은 기존 국가 예턴은 거부한다', async () => {
    const f = fixture();
    f.tx.nationTurn.findFirst.mockResolvedValue({ nationId: 1 });
    await expect(f.check(true)).rejects.toThrow('기존 국가 예턴');
  });

  it('저장 경계 조회 실패를 기능이 비어 있는 것으로 처리하지 않는다', async () => {
    const f = fixture();
    f.tx.assignmentOffer.findFirst.mockRejectedValue(new Error('조회 실패'));
    await expect(f.check(false)).rejects.toThrow('조회 실패');
  });
});
