import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import type { EngineInput, EngineWorld } from './features';
import { processProposalRecord } from './proposalRecord';

describe('AC-M1-14 제안 엔진 기록', () => {
  it.each(['create', 'approve', 'reject', 'cancel'])(
    '%s의 개인·국가 기록과 승인 공헌을 같은 트랜잭션에 쓴다',
    async (action) => {
      const tx = {
        general: { update: vi.fn() },
        generalLog: { create: vi.fn() },
        nationHistory: {
          findUnique: vi.fn(async () => ({ data: { gold: 100, events: ['이전 사건'] } })),
          upsert: vi.fn(),
        },
      };
      const payload = {
        proposalId: '10000000-0000-4000-8000-000000000001',
        proposerId: 1,
        nationId: 2,
        action,
        text: '제안 처리',
      };
      expect(
        await processProposalRecord(
          tx as unknown as Prisma.TransactionClient,
          { id: 'world' } as EngineWorld,
          { payload } as unknown as EngineInput,
          { tick: 100, sequence: 3 },
        ),
      ).toEqual({ status: 'APPLIED', result: { dedication: action === 'approve' ? 10 : 0 } });
      expect(tx.general.update).toHaveBeenCalledTimes(action === 'approve' ? 1 : 0);
      if (action === 'approve')
        expect(tx.general.update).toHaveBeenCalledWith({
          where: { worldId_id: { worldId: 'world', id: 1 } },
          data: { dedication: { increment: 10 } },
        });
      expect(tx.generalLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ generalId: 1, kind: 'proposal', tick: 100, sequence: 3 }),
      });
      expect(tx.nationHistory.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            data: {
              gold: 100,
              events: ['이전 사건', '제안 처리'],
              proposals: [{ kind: 'proposal', text: '제안 처리' }],
            },
          },
        }),
      );
    },
  );
});
