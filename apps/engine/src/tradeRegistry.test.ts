import type { Prisma } from '@opensamguk/db';
import { describe, expect, it, vi } from 'vitest';
import { projectTreatyRows, ruleRegistry, trade } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';
import { engineResolver } from './extState';
import { processTreatyQueuedInput } from './treatyInput';
import { queuedInputHandlers } from './inputs';
import { monthlyFixture } from '../test/monthlyFixture';
import { readArchive, resourceHashV3, type ReplayArchiveV3 } from './replay';
vi.mock('./treatyInput', () => ({ processTreatyQueuedInput: vi.fn(async () => ({ status: 'REJECTED', result: {} })) }));

describe('형식 3 교역의 엔진·API·재생 연결', () => {
  it('엔진은 같은 feature 명령을 고르고 legacy 선택은 교역을 노출하지 않는다', () => {
    const modern = { preset: null, replayFormat: 3, ruleFeatures: ['treaty', 'treaty-trade'] };
    expect(engineResolver(modern).resolver.get('trade')).toBe(trade);
    for (const replayFormat of [1, 6])
      expect(engineResolver({ ...modern, replayFormat, ruleFeatures: [] }).resolver.get('trade')).toBeUndefined();
  });
  it('같은 production handler가 제안·응답·파기마다 명시 선택 문맥을 넘긴다', async () => {
    const handlers = queuedInputHandlers();
    expect(Object.keys(handlers).sort()).toEqual(
      ruleRegistry.inputKinds
        .filter((kind) => kind.route === 'queued')
        .map((kind) => kind.kind)
        .sort(),
    );
    for (const kind of ['treaty.propose', 'treaty.respond', 'treaty.break']) {
      const world = { ruleFeatures: ['treaty', 'treaty-break', 'treaty-trade'] } as Prisma.WorldGetPayload<
        Record<string, never>
      >;
      await handlers[kind]!(
        {} as Prisma.TransactionClient,
        world,
        {} as Prisma.InputEventGetPayload<Record<string, never>>,
        { tick: 100, sequence: 5 },
      );
      expect(processTreatyQueuedInput).toHaveBeenLastCalledWith(expect.anything(), world, expect.anything(), {
        tick: 100,
        sequence: 5,
        treatyTradeEnabled: true,
        ...(kind === 'treaty.break' ? { treatyBreakEnabled: true } : {}),
      });
    }
  });
  it('기본 projection은 교역을 거부하고 명시 옵션만 유효한 저장 행을 읽는다', () => {
    const row = {
      id: 1,
      fromNationId: 1,
      toNationId: 2,
      clauses: [{ kind: 'trade', months: 3 }],
      status: 'ACTIVE',
      proposedTick: 0,
      respondByTick: 60000,
      startTick: 0,
      endTick: 30000,
      costFrom: 50,
      costTo: 25,
      closedSequence: null,
    };
    expect(() => projectTreatyRows([row])).toThrow();
    expect(projectTreatyRows([row], { tradeEnabled: true })).toMatchObject([
      { clauses: [{ kind: 'trade', months: 3 }] },
    ]);
    expect(() =>
      projectTreatyRows([{ ...row, status: 'ENDED', closedSequence: 2, endTick: 30001 }], { tradeEnabled: true }),
    ).toThrow();
  });
  it('교역 APPLIED 기록은 선택된 feature 문맥으로만 보관 검사에 통과한다', async () => {
    const initial = await monthlyFixture();
    initial.ruleFeatures = ['treaty', 'treaty-trade'];
    const origin: ReplayArchiveV3['origin'] = {
      version: 3,
      initial,
      initialStateHash: hashState(initial),
      resourceHash: '',
    };
    origin.resourceHash = resourceHashV3(origin);
    const archive: ReplayArchiveV3 = {
      version: 3,
      origin,
      config: { endYear: null, outcomeFromSequence: 0 },
      inputs: [
        {
          sequence: 1,
          tick: 50,
          generalId: 1,
          kind: 'treaty.propose',
          status: 'APPLIED',
          payload: { toNationId: 2, clauses: [{ kind: 'trade', months: 3 }] },
          result: { outcome: 'PROPOSED', tick: 50, treatyId: '1', respondByTick: 60050 },
        },
      ],
      months: [],
      end: {
        sequence: 10,
        tick: 100,
        reason: 'UNIFIED',
        winnerNationId: 1,
        year: 191,
        month: 1,
        finalStateHash: 'checked-by-full-replay',
      },
      afterEnd: [],
    };
    expect(() => readArchive(archive)).not.toThrow();
    archive.origin.initial.ruleFeatures = ['treaty'];
    archive.origin.initialStateHash = hashState(archive.origin.initial);
    expect(() => readArchive(archive)).toThrow('조항');
  });
});
