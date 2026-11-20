import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import { TICKS_PER_MONTH } from '@opensamguk/rules';
import { readFileSync } from 'node:fs';
import {
  createProposal,
  listProposals,
  listProposableCommands,
  readProposalHistory,
  respondProposal,
} from './proposals';

vi.mock('./queries', async (original) => ({
  ...(await original<typeof import('./queries')>()),
  readView: vi.fn(async () => ({
    generals: { 1: { id: 1, nationId: 1, officerLevel: 1 }, 2: { id: 2, nationId: 1, officerLevel: 12 } },
    nations: { 1: { id: 1, gold: 0 } },
  })),
}));

function fixture() {
  const world = {
    id: 'world',
    status: 'RUNNING',
    replayFormat: 3,

    clockTick: 100,
    preset: null,
    replayOrigin: null,
    unitSet: JSON.parse(readFileSync(new URL('../../../../resources/unitset/che.json', import.meta.url), 'utf8')),
  };
  const proposer = {
    id: 1,
    userId: 'proposer',
    name: '제안자',
    nationId: 1 as number | null,
    officerLevel: 1,
    removedAt: null,
    portraitId: 1,
  };
  const ruler = { ...proposer, id: 2, userId: 'ruler', name: '군주', officerLevel: 12 };
  const foreign = { ...ruler, id: 3, userId: 'foreign', nationId: 2 };
  const generals = [proposer, ruler, foreign];
  type Row = Prisma.CommandProposalGetPayload<Record<string, never>>;
  const rows: Row[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    world: { findUnique: vi.fn(async () => world), update: vi.fn(async () => ({ actionSequence: 1 })) },
    general: {
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async ({ where }) =>
        generals.find((g) =>
          where.worldId_userId ? g.userId === where.worldId_userId.userId : g.id === where.worldId_id.id,
        ),
      ),
      findMany: vi.fn(async ({ where }) => generals.filter((g) => g.nationId === where.nationId)),
    },
    nation: { findUniqueOrThrow: vi.fn(async () => ({ level: 1 })) },
    nationOffice: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    nationOfficeTurn: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
    commandProposal: {
      findMany: vi.fn(async ({ where }) =>
        rows.filter(
          (r) =>
            r.worldId === where.worldId &&
            (where.nationId === undefined || r.nationId === where.nationId) &&
            (where.proposerId === undefined || r.proposerId === where.proposerId) &&
            (where.status === undefined || r.status === where.status),
        ),
      ),
      findUnique: vi.fn(async ({ where }) => rows.find((r) => r.id === where.id) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }) => rows.find((r) => r.id === where.id)!),
      create: vi.fn(async ({ data }) => {
        const row = {
          id: `10000000-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`,
          slot: null,
          note: null,
          responseBy: null,
          responseTick: null,
          reason: null,
          ...data,
          status: 'PENDING',
        } as Row;
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    inputEvent: { create: vi.fn(async () => ({})) },
  };
  const db = tx as unknown as Prisma.TransactionClient;
  const input = { worldId: 'world', commandKey: 'nation_reward', args: { generalId: 1, resource: 'gold', amount: 10 } };
  const create = (patch = {}) => createProposal(db, 'proposer', { ...input, ...patch });
  return { world, proposer, ruler, foreign, tx, db, rows, input, create };
}
describe('AC-M1-14 상신 서버', () => {
  it.each([
    [5_000, 'PENDING'],
    [119_999, 'PENDING'],
    [120_000, 'EXPIRED'],
    [120_001, 'EXPIRED'],
  ])('생성 후 %i틱에서 받은 제안 상태는 %s다 (12턴 만료)', async (elapsed, status) => {
    const f = fixture();
    const createdTick = f.world.clockTick;
    const { proposalId } = await f.create();
    f.world.clockTick = createdTick + elapsed;
    expect(await listProposals(f.db, 'ruler', { worldId: 'world', box: 'received' })).toEqual([
      expect.objectContaining({ id: proposalId, status, createdTick, expiresTick: createdTick + 120_000 }),
    ]);
  });
  it('국가 상신 기록은 세션 장수의 국가로 한정해 조회한다', async () => {
    const f = fixture();
    await readProposalHistory(f.db, 'world', 'proposer');
    const call = f.tx.$queryRaw.mock.calls[0] as unknown as unknown[];
    expect(call.slice(1)).toEqual(['world', 1]);
    f.proposer.nationId = null;
    await expect(readProposalHistory(f.db, 'world', 'proposer')).rejects.toThrow('국가에 소속');
  });
  it('일반 장수에게 상신 가능한 명령·인자 형식을 주고 자기 실행 명령을 뺀다', async () => {
    const f = fixture();
    expect(await listProposableCommands(f.db, 'world', 'proposer')).toContainEqual(
      expect.objectContaining({ key: 'nation_reward', argsSchema: expect.any(Object) }),
    );
    expect(await listProposableCommands(f.db, 'world', 'ruler')).toEqual([]);
  });
  it('받은 권한자에게만 사전 검사 경고를 보이고 보낸 제안자는 응답을 확인한다', async () => {
    const f = fixture();
    await f.create();
    expect(await listProposals(f.db, 'ruler', { worldId: 'world', box: 'received', status: 'PENDING' })).toEqual([
      expect.objectContaining({
        proposer: expect.objectContaining({ id: 1 }),
        precheck: { ok: false, message: '자원이 부족합니다.' },
      }),
    ]);
    expect(await listProposals(f.db, 'proposer', { worldId: 'world', box: 'received' })).toEqual([]);
    expect(await listProposals(f.db, 'foreign', { worldId: 'world', box: 'received' })).toEqual([]);
    expect(await listProposals(f.db, 'proposer', { worldId: 'world', box: 'sent' })).toHaveLength(1);
    f.world.clockTick = 100 + 12 * TICKS_PER_MONTH;
    expect(await listProposals(f.db, 'ruler', { worldId: 'world', box: 'received', status: 'PENDING' })).toEqual([]);
    expect(await listProposals(f.db, 'proposer', { worldId: 'world', box: 'sent' })).toEqual([
      expect.objectContaining({ status: 'EXPIRED' }),
    ]);
  });
  it('개인 명령·잘못된 인자·직접 실행 권한을 거부한다', async () => {
    const f = fixture();
    await expect(f.create({ commandKey: 'rest' })).rejects.toThrow('국가 명령');
    await expect(f.create({ args: { bad: true } })).rejects.toThrow('국가 명령');
    await expect(createProposal(f.db, 'ruler', f.input)).rejects.toThrow('직접 실행');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it('인자 키 순서가 달라도 중복을 막고 열린 제안을 세 건으로 제한한다', async () => {
    const f = fixture();
    await f.create();
    await expect(f.create({ args: { amount: 10, resource: 'gold', generalId: 1 } })).rejects.toThrow('같은 명령');
    f.foreign.nationId = 1;
    f.foreign.officerLevel = 1;
    await expect(createProposal(f.db, 'foreign', f.input)).rejects.toThrow('같은 명령');
    await f.create({ args: { ...f.input.args, amount: 11 } });
    await f.create({ args: { ...f.input.args, amount: 12 } });
    await expect(f.create({ args: { ...f.input.args, amount: 13 } })).rejects.toThrow('3건');
    f.world.clockTick = 100 + 12 * TICKS_PER_MONTH;
    await expect(f.create()).resolves.toHaveProperty('proposalId');
    expect(f.rows.slice(0, 3).every((row) => row.status === 'EXPIRED')).toBe(true);
  });
  it('승인은 기존 저장 경로로 선택한 직책 칸을 채우고 한 번만 기록한다', async () => {
    const f = fixture();
    const { proposalId } = await f.create({ slot: 4 });
    f.world.clockTick += 5_000;
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'approve', slot: 2 })).resolves.toMatchObject({
      status: 'APPROVED',
    });
    expect(f.tx.nationOfficeTurn.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ officerLevel: 12, slot: 2, commandKey: 'nation_reward', args: f.input.args }),
      ]),
    });
    expect(f.tx.inputEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'nationTurns.set' }) });
    expect(f.tx.inputEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'proposal.record',
        payload: expect.objectContaining({ action: 'approve', proposerId: 1 }),
      }),
    });
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'approve', slot: 3 })).rejects.toThrow(
      '종료된',
    );
  });
  it('거절 사유를 저장하고 제안자 개인 기록 입력을 남기며 예턴은 건드리지 않는다', async () => {
    const f = fixture();
    const { proposalId } = await f.create();
    await respondProposal(f.db, 'ruler', { proposalId, decision: 'reject', reason: '국고 부족' });
    expect(f.rows[0]).toMatchObject({ status: 'REJECTED', reason: '국고 부족', responseBy: 2, responseTick: 100 });
    expect(f.tx.inputEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({ action: 'reject', text: expect.stringContaining('국고 부족') }),
      }),
    });
    expect(f.tx.nationOfficeTurn.createMany).not.toHaveBeenCalled();
  });
  it('타국에는 목록을 숨기고 응답·취소를 막는다', async () => {
    const f = fixture();
    const { proposalId } = await f.create();
    expect(await listProposals(f.db, 'foreign', { worldId: 'world', box: 'sent' })).toEqual([]);
    await expect(respondProposal(f.db, 'foreign', { proposalId, decision: 'approve', slot: 0 })).rejects.toThrow(
      '제안이 없습니다',
    );
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'cancel' })).rejects.toThrow('권한');
    await expect(respondProposal(f.db, 'proposer', { proposalId, decision: 'reject' })).rejects.toThrow('권한');
    await respondProposal(f.db, 'proposer', { proposalId, decision: 'cancel' });
    expect(f.rows[0]!.status).toBe('CANCELLED');
  });
  it('만료·직위 변경·이탈 뒤 승인과 칸 없는 승인을 거부한다', async () => {
    const f = fixture();
    const { proposalId } = await f.create();
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'approve' })).rejects.toThrow('칸');
    f.world.clockTick = 100 + 12 * TICKS_PER_MONTH;
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'approve', slot: 0 })).rejects.toThrow(
      '종료된',
    );
    f.world.clockTick = 100;
    f.proposer.officerLevel = 5;
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'approve', slot: 0 })).rejects.toThrow(
      '종료된',
    );
    f.proposer.officerLevel = 1;
    f.proposer.nationId = 2;
    await expect(respondProposal(f.db, 'ruler', { proposalId, decision: 'approve', slot: 0 })).rejects.toThrow(
      '종료된',
    );
  });
});
