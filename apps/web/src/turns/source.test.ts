import type { AppRouter } from '@opensamguk/server/router';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import type { inferRouterOutputs } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOps, toSaveSlots, toTurn } from './draft';
import { personalSource } from './source';

// 저장은 전역 trpcClient.turns.set으로 간다. 시험은 그 mutate만 바꿔 보낸 입력과 돌려준 결과를 본다.
// 가짜 응답이라 실제 API·DB 증거가 아니다. 개인 칸 연결이 서버 칸 정보를 그대로 잇는지만 본다.
const setMutate = vi.hoisted(() => vi.fn());
vi.mock('../trpc', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trpcClient: { turns: { set: { mutate: setMutate } } },
}));

type Outputs = inferRouterOutputs<AppRouter>;

// 값이 AppRouter 출력 타입에 맞는지 컴파일러가 본다. 지금 API에서 explicit이 빠지면 컴파일이 깨진다.
// 여분 필드는 보지 않으므로 explicit이 없는 옛 API 타입에서도 같은 값이 컴파일된다.
const getOutput = <T extends Outputs['turns']['get']>(value: T) => value;
const setOutput = <T extends Outputs['turns']['set']>(value: T) => value;

const emptySlot = () => ({ commandKey: 'rest', args: {}, name: '휴식', explicit: false });
const fill = (count: number) => Array.from({ length: count }, emptySlot);

// 0번 직접 이동, 1번 빈칸, 2번 직접 휴식, 나머지 빈칸.
const read = getOutput({
  revision: 4,
  slots: [
    { commandKey: 'move', args: { cityKey: 3 }, name: '이동', explicit: true },
    { commandKey: 'rest', args: {}, name: '휴식', explicit: false },
    { commandKey: 'rest', args: {}, name: '휴식', explicit: true },
    ...fill(27),
  ],
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 조회는 tRPC 클라이언트를 거친다. 응답은 JSON으로 한 번 오간 값이다.
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.path === 'turns.get') {
          observer.next({ result: { type: 'data', data: JSON.parse(JSON.stringify(read)) } });
          observer.complete();
        } else observer.error(TRPCClientError.from(new Error(`unexpected ${op.path}`)));
      });
  const client = createTRPCClient<AppRouter>({ links: [link] });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
  const source = personalSource({ trpc, userId: 'u1', worldId: 'w1' });
  const cached = () => source.list.select(queryClient.getQueryData(source.list.queryKey));
  return { queryClient, source, cached };
}

beforeEach(() => setMutate.mockReset());

describe('개인 예턴 연결', () => {
  it('조회한 칸의 빈칸·직접 휴식과 이름·인자를 그대로 읽는다', async () => {
    const { queryClient, source } = setup();
    const data = await queryClient.query({ queryKey: source.list.queryKey, queryFn: source.list.queryFn });
    const list = source.list.select(data);
    expect(list).toEqual(read);
    expect(list.slots.slice(0, 3).map(toTurn)).toEqual([
      { commandKey: 'move', args: { cityKey: 3 }, explicit: true },
      { commandKey: 'rest', args: {}, explicit: false },
      { commandKey: 'rest', args: {}, explicit: true },
    ]);
  });

  it('편집한 칸을 저장 입력으로 보낼 때 빈칸은 null, 직접 휴식은 객체이고 이름과 explicit은 보내지 않는다', async () => {
    const { source } = setup();
    setMutate.mockResolvedValueOnce(setOutput({ ok: true, revision: 5, slots: read.slots }));
    const turns = applyOps(read.slots.map(toTurn), [{ shift: 1 }]);
    await source.save({ revision: read.revision, slots: toSaveSlots(turns) });
    expect(setMutate).toHaveBeenCalledTimes(1);
    const sent = setMutate.mock.calls[0]![0] as { worldId: string; revision: number; slots: unknown[] };
    expect(sent).toStrictEqual({
      worldId: 'w1',
      revision: 4,
      slots: [
        null,
        { commandKey: 'move', args: { cityKey: 3 } },
        null,
        { commandKey: 'rest', args: {} },
        ...Array.from({ length: 26 }, () => null),
      ],
    });
    expect(JSON.stringify(sent.slots)).not.toMatch(/name|explicit/);
  });

  it('저장 성공 결과를 캐시에 넣어도 칸 정보가 그대로다', async () => {
    const { queryClient, source, cached } = setup();
    const saved = setOutput({
      ok: true,
      revision: 5,
      slots: [
        { commandKey: 'rest', args: {}, name: '휴식', explicit: false },
        { commandKey: 'move', args: { cityKey: 3 }, name: '이동', explicit: true },
        { commandKey: 'rest', args: {}, name: '휴식', explicit: false },
        { commandKey: 'rest', args: {}, name: '휴식', explicit: true },
        ...fill(26),
      ],
    });
    setMutate.mockResolvedValueOnce(saved);
    const result = await source.save({ revision: 4, slots: toSaveSlots(read.slots.map(toTurn)) });
    // useTurnDraft의 저장 onSuccess와 같은 쓰기다.
    source.writeList(queryClient, { revision: result.revision, slots: result.slots });
    expect(cached()).toEqual({ revision: 5, slots: saved.slots });
    expect(cached().slots.slice(0, 4).map(toTurn)).toEqual([
      { commandKey: 'rest', args: {}, explicit: false },
      { commandKey: 'move', args: { cityKey: 3 }, explicit: true },
      { commandKey: 'rest', args: {}, explicit: false },
      { commandKey: 'rest', args: {}, explicit: true },
    ]);
  });

  it('STALE로 받은 최신 칸을 캐시에 넣어도 빈칸과 직접 휴식이 그대로다', async () => {
    const { queryClient, source, cached } = setup();
    const stale = setOutput({
      ok: false,
      reason: 'STALE',
      revision: 7,
      slots: [
        { commandKey: 'rest', args: {}, name: '휴식', explicit: true },
        { commandKey: 'rest', args: {}, name: '휴식', explicit: false },
        { commandKey: 'farm', args: {}, name: '농지 개간', explicit: true },
        ...fill(27),
      ],
    });
    setMutate.mockResolvedValueOnce(stale);
    const result = await source.save({ revision: 4, slots: toSaveSlots(read.slots.map(toTurn)) });
    expect(result.ok).toBe(false);
    source.writeList(queryClient, { revision: result.revision, slots: result.slots });
    expect(cached()).toEqual({ revision: 7, slots: stale.slots });
    expect(toSaveSlots(cached().slots.map(toTurn)).slice(0, 4)).toEqual([
      { commandKey: 'rest', args: {} },
      null,
      { commandKey: 'farm', args: {} },
      null,
    ]);
  });
});
