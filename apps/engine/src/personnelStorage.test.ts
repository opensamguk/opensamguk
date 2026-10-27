import type { Prisma } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { assertPersonnelStorage } from './personnelState';

function fixture() {
  const tx = {
    nationOffice: { findFirst: vi.fn().mockResolvedValue(null) },
    nationOfficeTurn: { findFirst: vi.fn().mockResolvedValue(null) },
    assignmentOffer: { findFirst: vi.fn().mockResolvedValue(null) },
    nationTurn: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([{ present: false }]),
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
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = f.tx.$queryRaw.mock.calls[0]! as unknown as [TemplateStringsArray, ...unknown[]];
    for (const table of ['NationOffice', 'NationOfficeTurn', 'AssignmentOffer'])
      expect(sql.join('?')).toContain(`FROM "${table}" WHERE "worldId" =`);
    expect(values).toEqual(['world', 'world', 'world']);
    expect(f.tx.nationTurn.findFirst).not.toHaveBeenCalled();
  });

  it.each([{ rows: [{ present: true }] }, { rows: [] }, { rows: [{ present: null }] }])(
    '기능을 끈 월드의 저장 행 또는 잘못된 조회 결과 %j를 거부한다',
    async ({ rows }) => {
      const f = fixture();
      f.tx.$queryRaw.mockResolvedValue(rows);
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
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('기능을 켠 월드에 남은 기존 국가 예턴은 거부한다', async () => {
    const f = fixture();
    f.tx.nationTurn.findFirst.mockResolvedValue({ nationId: 1 });
    await expect(f.check(true)).rejects.toThrow('기존 국가 예턴');
  });

  it('저장 경계 조회 실패를 기능이 비어 있는 것으로 처리하지 않는다', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockRejectedValue(new Error('조회 실패'));
    await expect(f.check(false)).rejects.toThrow('조회 실패');
  });
});
