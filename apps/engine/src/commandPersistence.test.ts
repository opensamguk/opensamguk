import type { Prisma } from '@opensamguk/db';
import { initialReplayState, providedRuleData, type WorldState } from '@opensamguk/rules';
import { beforeEach, expect, it, vi } from 'vitest';
import { monthlyFixture } from '../test/monthlyFixture';
import { appendNationHistory, persistCommandState } from './commandPersistence';
import { persistEffects } from './persist';
import { loadWorld } from './worldLoader';

vi.mock('./worldLoader', () => ({ loadWorld: vi.fn() }));
let initial: Awaited<ReturnType<typeof monthlyFixture>>;
beforeEach(async () => {
  vi.clearAllMocks();
  initial = await monthlyFixture();
});

it('국가 사건의 문자열 배열과 조각은 같은 본문을 저장하고 옛 사건을 보존한다', async () => {
  const upsert = vi.fn();
  const tx = {
    nationHistory: {
      findUnique: vi.fn().mockResolvedValue({ data: { events: ['옛 사건'], intelAlerts: [] } }),
      upsert,
    },
  };
  await appendNationHistory(tx as unknown as Prisma.TransactionClient, worldId, 100, 1, '대체 전 본문', 'intel', [
    { t: 'text', v: '조각 본문' },
  ]);
  const data = upsert.mock.calls[0]![0].create.data;
  expect(data.events).toEqual(['옛 사건', '조각 본문']);
  expect(data.intelAlerts).toEqual(['조각 본문']);
  expect(data.structuredEvents).toEqual([
    {
      ordinal: 1,
      kind: 'intel',
      visibility: 'nation',
      text: '조각 본문',
      parts: [{ t: 'text', v: '조각 본문' }],
      partsVersion: 1,
    },
  ]);
});

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
    commandProposal: { updateMany: write('commandProposal.updateMany') },
    diplomacy: { deleteMany: write('diplomacy.deleteMany'), createMany: write('diplomacy.createMany') },
    nationTurn: { deleteMany: write('nationTurn.deleteMany'), createMany: write('nationTurn.createMany') },
    world: {
      update: write('world.update'),
      updateMany: vi.fn((...args: unknown[]) => {
        calls.push({ method: 'world.updateMany', args: structuredClone(args) });
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        unitSet: initial.unitSet,
        replayOrigin: {
          version: 3,
          initial,
          initialStateHash: '',
          resourceHash: '',
          featureData: providedRuleData(initial, 60),
        },
      })),
    },
    removedNation: { create: write('removedNation.create') },
    publicNationEvent: { createMany: write('publicNationEvent.createMany') },
    $executeRaw: write('$executeRaw'),
    $queryRaw: write('$queryRaw'),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

async function transition(): Promise<{ before: WorldState; after: WorldState }> {
  const before = initialReplayState(await monthlyFixture()).state;
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
  expect(supplied.calls).toContainEqual({
    method: 'publicNationEvent.createMany',
    args: [
      {
        data: expect.arrayContaining([
          expect.objectContaining({
            worldId,
            ...at,
            kind: 'fall',
            text: `${before.nations[2]!.name} 멸망`,
            nations: [{ id: 2, name: before.nations[2]!.name, color: before.nations[2]!.color }],
          }),
          ...Object.values(before.cities)
            .filter((city) => city.nationId === 2)
            .map((city) =>
              expect.objectContaining({
                worldId,
                ...at,
                kind: 'capture',
                text: `${before.nations[1]!.name}의 ${city.name} 점령`,
                nations: [{ id: 1, name: before.nations[1]!.name, color: before.nations[1]!.color }],
              }),
            ),
        ]),
      },
    ],
  });
  const generalUpdates = supplied.calls.filter(({ method }) => method === 'general.update');
  expect(generalUpdates.length).toBeGreaterThan(0);
  for (const { args } of generalUpdates) expect((args[0] as { data: object }).data).not.toHaveProperty('nextTurnTick');
  expect(before).toEqual(original);
});

it('이전 상태와 같은 결과는 조회와 행 쓰기를 모두 생략한다', async () => {
  const before = initialReplayState(await monthlyFixture()).state;
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

it('인사 기능에서 소속·직위 전환이 제안 원장을 영구 종료한다', async () => {
  const { before } = await transition();
  const next = structuredClone(before);
  next.generals[1]!.officerLevel = before.generals[1]!.officerLevel === 12 ? 1 : 12;
  const f = transaction();
  await persistCommandState(f.tx, worldId, next, at, before);
  expect(f.calls).toContainEqual({
    method: 'commandProposal.updateMany',
    args: [
      {
        where: { worldId, proposerId: { in: [1] }, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      },
    ],
  });
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
