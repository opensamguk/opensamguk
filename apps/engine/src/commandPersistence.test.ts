import type { Prisma } from '@opensamguk/db';
import { toWorldState, type WorldState } from '@opensamguk/rules';
import { beforeEach, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { persistCommandState } from './commandPersistence';
import { persistEffects } from './persist';
import { loadWorld } from './worldLoader';

vi.mock('./worldLoader', () => ({ loadWorld: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const worldId = '00000000-0000-4000-8000-000000000001';
const at = { sequence: 7, tick: 100 };

// SQL의 결과를 흉내 내지 않고 저장 요청만 비교한다. 실제 DB·재생은 통합 시험에서 확인한다.
function transaction() {
  const calls: { method: string; args: unknown[] }[] = [];
  const write = (method: string) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ method, args: structuredClone(args) });
    });
  const tx = {
    nation: { create: write('nation.create'), update: write('nation.update'), delete: write('nation.delete') },
    city: { update: write('city.update') },
    general: { update: write('general.update') },
    diplomacy: { deleteMany: write('diplomacy.deleteMany'), createMany: write('diplomacy.createMany') },
    nationTurn: { deleteMany: write('nationTurn.deleteMany'), createMany: write('nationTurn.createMany') },
    world: { update: write('world.update') },
    removedNation: { create: write('removedNation.create') },
    $executeRaw: write('$executeRaw'),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

async function transition(): Promise<{ before: WorldState; after: WorldState }> {
  const before = toWorldState(await monthlyFixture());
  const after = structuredClone(before);
  after.generals[1]!.gold += 1;
  after.generals[1]!.nextTurnTick += 30_000;
  after.nations[1]!.gold += 2;
  // 멸망 보존과 다른 장수·도시 변경도 기존 전체 조회 경로와 같아야 한다.
  delete after.nations[2];
  for (const city of Object.values(after.cities)) if (city.nationId === 2) city.nationId = 1;
  for (const general of Object.values(after.generals)) if (general.nationId === 2) general.nationId = 1;
  after.commandMeta = { nextNationId: 3, offers: {} };
  return { before, after };
}

it('같은 트랜잭션의 이전 상태를 넘기면 재조회 없이 기존과 같은 행·멸망 기록을 저장한다', async () => {
  const { before, after } = await transition();
  const original = structuredClone(before);
  const legacy = transaction();
  vi.mocked(loadWorld).mockResolvedValue(before);
  await persistCommandState(legacy.tx, worldId, after, at);
  expect(loadWorld).toHaveBeenCalledExactlyOnceWith(legacy.tx, worldId);

  vi.mocked(loadWorld).mockClear();
  const supplied = transaction();
  await persistCommandState(supplied.tx, worldId, after, at, before);
  expect(loadWorld).not.toHaveBeenCalled();
  expect(supplied.calls).toEqual(legacy.calls);
  expect(supplied.calls).toContainEqual({
    method: 'removedNation.create',
    args: [
      {
        data: {
          worldId,
          nationId: 2,
          name: before.nations[2]!.name,
          color: before.nations[2]!.color,
          removedSequence: 7,
          removedTick: 100,
        },
      },
    ],
  });
  const generalUpdates = supplied.calls.filter(({ method }) => method === 'general.update');
  expect(generalUpdates.length).toBeGreaterThan(0);
  for (const { args } of generalUpdates) expect((args[0] as { data: object }).data).not.toHaveProperty('nextTurnTick');
  expect(before).toEqual(original);
});

it('이전 상태와 같은 결과는 조회와 행 쓰기를 모두 생략한다', async () => {
  const before = toWorldState(await monthlyFixture());
  const supplied = transaction();
  await persistCommandState(supplied.tx, worldId, structuredClone(before), at, before);
  expect(loadWorld).not.toHaveBeenCalled();
  expect(supplied.calls).toEqual([]);
});

it('월드 효과도 이전 상태를 전달하고 기존 저장 요청과 원본을 보존한다', async () => {
  const { before, after } = await transition();
  const original = structuredClone(before);
  vi.mocked(loadWorld).mockResolvedValue(before);
  const legacy = transaction();
  await persistEffects(legacy.tx, worldId, after, [{ kind: 'world', state: after }], at);
  expect(loadWorld).toHaveBeenCalledOnce();

  vi.mocked(loadWorld).mockClear();
  const supplied = transaction();
  await persistEffects(supplied.tx, worldId, after, [{ kind: 'world', state: after }], at, before);
  expect(loadWorld).not.toHaveBeenCalled();
  expect(supplied.calls).toEqual(legacy.calls);
  expect(before).toEqual(original);
});

it('후속 직책 저장은 새 국가 생성 뒤와 멸망 국가의 연쇄 삭제 전에 한 번 실행한다', async () => {
  const { before, after } = await transition();
  after.nations[3] = { ...before.nations[2]!, id: 3, name: '새 국가' };
  const supplied = transaction();
  const followup = vi.fn(async () => {
    supplied.calls.push({ method: 'office.transition', args: [] });
  });
  await persistEffects(supplied.tx, worldId, after, [{ kind: 'world', state: after }], at, before, followup);
  expect(followup).toHaveBeenCalledOnce();
  const methods = supplied.calls.map((call) => call.method);
  expect(methods.indexOf('nation.create')).toBeLessThan(methods.indexOf('office.transition'));
  expect(methods.indexOf('office.transition')).toBeLessThan(methods.indexOf('nation.delete'));
});
