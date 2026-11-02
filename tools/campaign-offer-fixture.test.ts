import { expect, it, vi } from 'vitest';
import { OfferRequestOrder, settleIndependentJoins } from '../e2e/campaign-offer-fixture';

function pausedRequest() {
  return { timing: () => ({ startTime: 0 }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('응답 전 timing0인 새 요청도 실제 클릭 뒤 도착했으면 붙잡는다', () => {
  const order = new OfferRequestOrder(),
    request = pausedRequest();
  order.arm();
  order.observe(request);
  expect(request.timing().startTime).toBeLessThan(Date.now());
  expect(order.claim(request)).toBe(true);
});

it('클릭 전에 도착한 poll은 route 처리가 클릭 뒤여도 붙잡지 않는다', () => {
  const order = new OfferRequestOrder(),
    oldPoll = pausedRequest(),
    fresh = pausedRequest();
  order.observe(oldPoll);
  order.arm();
  order.observe(fresh);
  expect(order.claim(oldPoll)).toBe(false);
  expect(order.beforeClick(oldPoll)).toBe(true);
  expect(order.claim(fresh)).toBe(true);
  expect(order.beforeClick(fresh)).toBe(false);
});

it('클릭하기 전 요청과 도착을 관측하지 못한 요청은 거부한다', () => {
  const order = new OfferRequestOrder(),
    request = pausedRequest(),
    unknown = pausedRequest();
  order.observe(request);
  expect(order.claim(request)).toBe(false);
  expect(order.beforeClick(request)).toBe(false);
  order.arm();
  expect(order.claim(unknown)).toBe(false);
  expect(order.beforeClick(unknown)).toBe(false);
});

it('같은 이전 요청을 다시 관측해도 새 요청으로 바뀌지 않는다', () => {
  const order = new OfferRequestOrder(),
    request = pausedRequest();
  order.observe(request);
  order.arm();
  order.observe(request);
  expect(order.claim(request)).toBe(false);
  expect(order.beforeClick(request)).toBe(true);
});

it('실제 클릭 뒤 여러 요청이 도착해도 최신 조회 하나만 붙잡는다', () => {
  const order = new OfferRequestOrder(),
    first = pausedRequest(),
    later = pausedRequest();
  order.arm();
  order.observe(first);
  order.observe(later);
  expect(order.claim(first)).toBe(true);
  expect(order.claim(first)).toBe(false);
  expect(order.claim(later)).toBe(false);
});

it('두 번째 클릭 경계로 이전 poll을 다시 분류하지 않는다', () => {
  const order = new OfferRequestOrder(),
    request = pausedRequest();
  order.observe(request);
  order.arm();
  expect(() => order.arm()).toThrow('한 번만');
  expect(order.beforeClick(request)).toBe(true);
});

it('다른 요청의 늦은 응답 시각이 바뀌어도 도착 분류는 유지한다', () => {
  const order = new OfferRequestOrder();
  let responseStartedAt = 0;
  const request = { timing: () => ({ startTime: responseStartedAt }) };
  order.observe(request);
  order.arm();
  responseStartedAt = Date.now() + 1;
  expect(order.claim(request)).toBe(false);
  expect(order.beforeClick(request)).toBe(true);
});

it('두 월드 출사를 함께 시작하고 둘 다 정착한 뒤 원래 순서의 결과를 반환한다', async () => {
  const left = deferred<string>(),
    right = deferred<string>(),
    trace: string[] = [];
  let settled = false;
  const cancel = vi.fn();
  const result = settleIndependentJoins(
    [
      async () => {
        trace.push('left:start');
        const value = await left.promise;
        trace.push('left:done');
        return value;
      },
      async () => {
        trace.push('right:start');
        const value = await right.promise;
        trace.push('right:done');
        return value;
      },
    ],
    cancel,
  );
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(trace).toEqual(['left:start', 'right:start']);
  right.resolve('right');
  await Promise.resolve();
  expect(settled).toBe(false);
  left.resolve('left');
  expect(await result).toEqual(['left', 'right']);
  expect(trace.indexOf('right:done')).toBeLessThan(trace.indexOf('left:done'));
  expect(cancel).not.toHaveBeenCalled();
});

it('한 월드 실패 뒤 형제 작업이 정착하기 전에는 반환하지 않고 두 오류를 보존한다', async () => {
  const first = deferred<number>(),
    second = deferred<number>();
  const firstError = new Error('first'),
    secondError = new Error('second');
  const cancellation = deferred<void>();
  const cancel = vi.fn(() => cancellation.resolve(undefined));
  let settled = false;
  const result = settleIndependentJoins([() => first.promise, () => second.promise], cancel);
  void result.catch(() => {
    settled = true;
  });
  const assertion = expect(result).rejects.toMatchObject({ errors: [firstError, secondError] });
  first.reject(firstError);
  await cancellation.promise;
  try {
    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  } finally {
    second.reject(secondError);
    await assertion;
  }
  expect(cancel).toHaveBeenCalledOnce();
});

it('시작 함수의 동기 예외도 보존하고 다른 시작 함수를 누락하거나 재실행하지 않는다', async () => {
  const failure = new Error('sync'),
    cancel = vi.fn();
  const first = vi.fn((): Promise<number> => {
    throw failure;
  });
  const second = vi.fn(async () => 2);
  await expect(settleIndependentJoins([first, second], cancel)).rejects.toMatchObject({ errors: [failure] });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
