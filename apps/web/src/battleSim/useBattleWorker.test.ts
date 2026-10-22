// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BattleRunBody, BattleRunReply, BattleRunRequest } from './request';
import { useBattleWorker, type WorkerLike } from './useBattleWorker';

// T4-34 Worker 수명. 가짜 Worker로 상태 전이만 본다. 진짜 Worker 실행은 e2e/battleSim.spec.ts가 본다.
class FakeWorker implements WorkerLike {
  posted: BattleRunRequest[] = [];
  terminated = 0;
  private listeners = new Map<string, Array<(event: never) => void>>();
  postMessage(message: BattleRunRequest) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated++;
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: 'message' | 'error' | 'messageerror', data?: unknown) {
    const event = type === 'message' ? { data } : { preventDefault() {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  reply(reply: BattleRunReply) {
    this.emit('message', reply);
  }
}

const body: BattleRunBody = {
  seed: '1',
  attacker: { crew: 1000, crewType: 1100, train: 50, atmos: 50 },
  defender: { crew: 1000, crewType: 1100, train: 50, atmos: 50 },
  attackerTech: 0,
  defenderTech: 0,
};
const result = (requestId: number, crew = 900): BattleRunReply => ({
  type: 'result',
  requestId,
  seed: body.seed,
  input: { attacker: body.attacker, defender: body.defender, attackerTech: 0, defenderTech: 0 },
  unitSetId: 'basic',
  attacker: { ...body.attacker, crew },
  defender: { ...body.defender, crew: 800 },
});

function setup() {
  const workers: FakeWorker[] = [];
  const hook = renderHook(() =>
    useBattleWorker(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }),
  );
  return { workers, hook };
}

afterEach(cleanup);

describe('useBattleWorker', () => {
  it('첫 실행 때 Worker를 만들고 requestId를 1부터 늘린다', () => {
    const { workers, hook } = setup();
    expect(workers).toHaveLength(0);
    act(() => hook.result.current.run(body));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted).toEqual([{ type: 'run', requestId: 1, ...body }]);
    expect(hook.result.current.state).toEqual({ status: 'running', requestId: 1 });
    act(() => workers[0]!.reply(result(1)));
    expect(hook.result.current.state).toEqual({ status: 'done', result: result(1) });
  });

  it('요청 1 뒤 요청 2를 보내면 늦게 온 1의 답은 버린다', () => {
    const { workers, hook } = setup();
    act(() => hook.result.current.run(body));
    act(() => hook.result.current.run({ ...body, seed: '2' }));
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted.map((m) => m.requestId)).toEqual([1, 2]);
    act(() => workers[0]!.reply(result(1, 111)));
    expect(hook.result.current.state).toEqual({ status: 'running', requestId: 2 });
    act(() => workers[0]!.reply(result(2, 222)));
    expect(hook.result.current.state).toEqual({ status: 'done', result: result(2, 222) });
    // 이미 받은 뒤 같은 번호의 답이 또 와도 바꾸지 않는다.
    act(() => workers[0]!.reply(result(2, 333)));
    expect(hook.result.current.state).toEqual({ status: 'done', result: result(2, 222) });
  });

  it('취소하면 terminate를 한 번 부르고 대기로 돌아가며 다음 실행은 새 Worker로 한다', () => {
    const { workers, hook } = setup();
    act(() => hook.result.current.run(body));
    act(() => hook.result.current.cancel());
    expect(workers[0]!.terminated).toBe(1);
    expect(hook.result.current.state).toEqual({ status: 'idle' });
    act(() => workers[0]!.reply(result(1)));
    expect(hook.result.current.state).toEqual({ status: 'idle' });
    act(() => hook.result.current.run(body));
    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted[0]!.requestId).toBe(2);
  });

  for (const [name, fire, code] of [
    ['error 이벤트', (w: FakeWorker) => w.emit('error'), 'WORKER'],
    ['messageerror 이벤트', (w: FakeWorker) => w.emit('messageerror'), 'WORKER'],
    [
      '오류 답',
      (w: FakeWorker) => w.reply({ type: 'error', requestId: 1, code: 'INVALID_INPUT', field: 'seed' }),
      'INVALID_INPUT',
    ],
  ] as const) {
    it(`${name}이면 terminate를 한 번 부르고 오류를 보이며 다시 실행은 새 Worker에 같은 본문을 보낸다`, () => {
      const { workers, hook } = setup();
      act(() => hook.result.current.run(body));
      act(() => fire(workers[0]!));
      expect(workers[0]!.terminated).toBe(1);
      expect(hook.result.current.state).toMatchObject({ status: 'error', code });
      act(() => hook.result.current.retry());
      expect(workers).toHaveLength(2);
      expect(workers[1]!.posted).toEqual([{ type: 'run', requestId: 2, ...body }]);
      // 끝낸 Worker에서 늦게 온 답은 무시한다.
      act(() => workers[0]!.reply(result(2, 1)));
      expect(hook.result.current.state).toEqual({ status: 'running', requestId: 2 });
      act(() => workers[1]!.reply(result(2)));
      expect(hook.result.current.state).toEqual({ status: 'done', result: result(2) });
      expect(workers[0]!.terminated).toBe(1);
    });
  }

  it('다른 requestId의 오류 답은 무시한다', () => {
    const { workers, hook } = setup();
    act(() => hook.result.current.run(body));
    act(() => workers[0]!.reply({ type: 'error', requestId: null, code: 'INVALID_INPUT', field: 'requestId' }));
    expect(workers[0]!.terminated).toBe(0);
    expect(hook.result.current.state).toEqual({ status: 'running', requestId: 1 });
  });

  it('언마운트하면 terminate를 한 번 부르고 그 뒤 답은 상태를 바꾸지 않는다', () => {
    const { workers, hook } = setup();
    act(() => hook.result.current.run(body));
    const before = hook.result.current.state;
    hook.unmount();
    expect(workers[0]!.terminated).toBe(1);
    act(() => workers[0]!.reply(result(1)));
    act(() => workers[0]!.emit('error'));
    expect(hook.result.current.state).toBe(before);
    expect(workers[0]!.terminated).toBe(1);
  });
});
