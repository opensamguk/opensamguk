import { expect, it } from 'vitest';
import {
  forgetLogisticsPending,
  logisticsActorChanged,
  logisticsStorageKey,
  readLogisticsPending,
  refreshFailureClearsView,
  requestModeAllowed,
  samePayload,
  writeLogisticsPending,
  type LogisticsPending,
} from './logisticsRequestState';

const requestId = '12345678-1234-4234-8234-123456789abc';
const dispatch = { type: 'dispatch', fromCityKey: 30, toCityKey: 28, goods: { iron: 0, wood: 2000, horses: 0 } };
const read = (value: unknown) => readLogisticsPending({ getItem: () => JSON.stringify(value) }, 'key');

it('T4-93 AC-P2-30 복구 값은 계정·월드별 키에서 UUID와 서버 입력 네 모양만 받는다', () => {
  for (const payload of [
    dispatch,
    { type: 'cancel', convoyId: 7 },
    { type: 'upgrade', cityKey: 30 },
    { type: 'trade', cityKey: 30, good: 'horses', side: 'sell', amount: 2_147_483_647 },
  ])
    expect(read({ requestId, payload })).toEqual({ requestId, payload });
  for (const invalid of [
    null,
    'text',
    { requestId: 'not-uuid', payload: dispatch },
    { requestId, payload: dispatch, expectedUserId: 'other' },
    { requestId, payload: { ...dispatch, extra: 1 } },
    { requestId, payload: { ...dispatch, toCityKey: 30 } },
    { requestId, payload: { ...dispatch, goods: { iron: 0, wood: 0, horses: 0 } } },
    { requestId, payload: { ...dispatch, goods: { iron: -1, wood: 2, horses: 0 } } },
    { requestId, payload: { ...dispatch, goods: { iron: 1.5, wood: 2, horses: 0 } } },
    { requestId, payload: { ...dispatch, goods: { iron: 2_147_483_648, wood: 0, horses: 0 } } },
    { requestId, payload: { ...dispatch, goods: { iron: 1, wood: 0, horses: 0, gold: 1 } } },
    { requestId, payload: { type: 'cancel', convoyId: 0 } },
    { requestId, payload: { type: 'upgrade', cityKey: '30' } },
    { requestId, payload: { type: 'trade', cityKey: 30, good: 'gold', side: 'buy', amount: 1 } },
    { requestId, payload: { type: 'trade', cityKey: 30, good: 'iron', side: 'swap', amount: 1 } },
    { requestId, payload: { type: 'recruit', cityKey: 30 } },
  ])
    expect(read(invalid)).toBeNull();
  expect(readLogisticsPending({ getItem: () => '{broken' }, 'key')).toBeNull();
  expect(logisticsStorageKey('A', 'one')).not.toBe(logisticsStorageKey('B', 'one'));
  expect(logisticsStorageKey('A', 'one')).not.toBe(logisticsStorageKey('A', 'two'));
});

it('T4-93 AC-P2-30 접수 기록을 못 찾은 요청은 같은 번호·내용으로만 다시 접수하고 새 요청은 막는다', () => {
  const pending: LogisticsPending = { requestId, payload: { type: 'upgrade', cityKey: 30 } };
  const base = { request: pending, pending, saved: pending, canManage: true, stale: false };
  // 같은 요청: 상태 확인과 재접수 가능. 새 제출은 기록이 남아 있는 동안 막는다.
  expect(requestModeAllowed('check', base)).toBe(true);
  expect(requestModeAllowed('resubmit', base)).toBe(true);
  const fresh: LogisticsPending = { requestId: '32345678-1234-4234-8234-123456789abc', payload: pending.payload };
  expect(requestModeAllowed('submit', { ...base, request: fresh })).toBe(false);
  expect(requestModeAllowed('submit', { ...base, request: fresh, pending: null })).toBe(false);
  expect(requestModeAllowed('submit', { ...base, request: fresh, pending: null, saved: null })).toBe(true);
  // 다른 번호나 다른 내용으로는 확인·재접수하지 않는다. 다른 거점의 저장 요청도 내용 그대로만 쓴다.
  expect(requestModeAllowed('resubmit', { ...base, request: fresh })).toBe(false);
  const changed = { requestId, payload: { type: 'upgrade' as const, cityKey: 31 } };
  expect(requestModeAllowed('resubmit', { ...base, request: changed })).toBe(false);
  expect(requestModeAllowed('check', { ...base, request: changed })).toBe(false);
  // 탭 기록이 바뀌었거나 관리 권한이 없으면 재접수하지 않고 상태 확인만 한다.
  expect(requestModeAllowed('resubmit', { ...base, saved: null })).toBe(false);
  expect(requestModeAllowed('resubmit', { ...base, saved: changed })).toBe(false);
  expect(requestModeAllowed('resubmit', { ...base, canManage: false })).toBe(false);
  expect(requestModeAllowed('check', { ...base, canManage: false, saved: null })).toBe(true);
  // 값이 오래됐으면 새 제출만 막는다.
  expect(requestModeAllowed('submit', { ...base, request: fresh, pending: null, saved: null, stale: true })).toBe(
    false,
  );
  expect(requestModeAllowed('resubmit', { ...base, stale: true })).toBe(true);
});

it('다시 조회 실패는 계정·권한 상실 응답에서만 화면을 지우고 연결 실패는 남긴다', () => {
  expect(refreshFailureClearsView(undefined, false)).toBe(false);
  expect(refreshFailureClearsView('INTERNAL_SERVER_ERROR', false)).toBe(false);
  expect(refreshFailureClearsView('TOO_MANY_REQUESTS', false)).toBe(false);
  expect(refreshFailureClearsView(undefined, true)).toBe(true);
  for (const code of ['UNAUTHORIZED', 'FORBIDDEN', 'CONFLICT', 'PRECONDITION_FAILED', 'NOT_FOUND'])
    expect(refreshFailureClearsView(code, false)).toBe(true);
});

it('같은 내용 비교는 칸 순서와 상관없고 다른 요청 기록은 지우지 않는다', () => {
  expect(
    samePayload(dispatch, {
      goods: { horses: 0, wood: 2000, iron: 0 },
      toCityKey: 28,
      fromCityKey: 30,
      type: 'dispatch',
    }),
  ).toBe(true);
  expect(samePayload(dispatch, { ...dispatch, goods: { iron: 0, wood: 2001, horses: 0 } })).toBe(false);
  let raw = 'null';
  let removed = 0;
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
    removeItem: () => {
      removed++;
      raw = 'null';
    },
  };
  const request = { requestId, payload: { type: 'cancel' as const, convoyId: 7 } };
  writeLogisticsPending(storage, 'key', { ...request, requestId: '22345678-1234-4234-8234-123456789abc' });
  expect(forgetLogisticsPending(storage, 'key', request)).toBe(false);
  writeLogisticsPending(storage, 'key', { requestId, payload: { type: 'cancel', convoyId: 8 } });
  expect(forgetLogisticsPending(storage, 'key', request)).toBe(false);
  expect(removed).toBe(0);
  writeLogisticsPending(storage, 'key', request);
  expect(readLogisticsPending(storage, 'key')).toEqual(request);
  expect(forgetLogisticsPending(storage, 'key', request)).toBe(true);
  expect(removed).toBe(1);
});

it('T4-95 AC-P2-32 새 기록은 처음 보낸 장수 id를 함께 두고, 장수 id 없는 예전 기록도 그대로 읽는다', () => {
  let raw = 'null';
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, value: string) => {
      raw = value;
    },
    removeItem: () => {
      raw = 'null';
    },
  };
  const mine: LogisticsPending = { requestId, generalId: 10, payload: { type: 'upgrade', cityKey: 30 } };
  writeLogisticsPending(storage, 'key', mine);
  expect(JSON.parse(raw)).toEqual({ requestId, generalId: 10, payload: { type: 'upgrade', cityKey: 30 } });
  expect(readLogisticsPending(storage, 'key')).toEqual(mine);
  // 예전 기록(장수 id 없음)은 읽되 generalId 칸을 만들지 않는다.
  const legacy = read({ requestId, payload: { type: 'upgrade', cityKey: 30 } });
  expect(legacy).toEqual({ requestId, payload: { type: 'upgrade', cityKey: 30 } });
  expect(legacy && Object.hasOwn(legacy, 'generalId')).toBe(false);
  for (const generalId of [0, -1, 1.5, '10', null, 2_147_483_648])
    expect(read({ requestId, generalId, payload: { type: 'upgrade', cityKey: 30 } }), String(generalId)).toBeNull();

  // 같은 번호·내용이라도 보낸 장수가 다르면 같은 요청이 아니다. 재접수·지우기 모두 하지 않는다.
  const moved: LogisticsPending = { ...mine, generalId: 11 };
  const base = { request: mine, pending: mine, saved: mine, canManage: true, stale: false };
  expect(requestModeAllowed('resubmit', base)).toBe(true);
  expect(requestModeAllowed('resubmit', { ...base, request: moved })).toBe(false);
  expect(requestModeAllowed('resubmit', { ...base, saved: moved })).toBe(false);
  expect(requestModeAllowed('check', { ...base, request: moved })).toBe(false);
  expect(forgetLogisticsPending(storage, 'key', moved)).toBe(false);
  expect(readLogisticsPending(storage, 'key')).toEqual(mine);

  expect(logisticsActorChanged(mine, 11)).toBe(true);
  expect(logisticsActorChanged(mine, 10)).toBe(false);
  expect(logisticsActorChanged(legacy!, 11)).toBe(false);
});
