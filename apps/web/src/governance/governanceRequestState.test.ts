import { expect, it } from 'vitest';
import {
  forgetGovernancePending,
  governanceActorChanged,
  governanceModeAllowed,
  governanceStorageKey,
  readGovernancePending,
  sameGovernancePayload,
  writeGovernancePending,
  type GovernancePending,
} from './governanceRequestState';

const requestId = '12345678-1234-4234-8234-123456789abc';
const other = '32345678-1234-4234-8234-123456789abc';
const offer = {
  type: 'vassal.offer',
  authority: 'OWN',
  targetNationId: 3,
  direction: 'DEMAND',
  goldBp: 500,
  riceBp: 0,
};
const read = (value: unknown) => readGovernancePending({ getItem: () => JSON.stringify(value) }, 'key');
const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

it('T4-94 AC-P2-31 복구 값은 계정·월드별 키에서 UUID와 서버 입력 스키마 모양만 받는다', () => {
  for (const payload of [
    { type: 'throne.ascend' },
    { type: 'throne.abdicate' },
    offer,
    { ...offer, authority: 'EMPIRE', direction: 'REQUEST', goldBp: 10_000, riceBp: 10_000 },
    { type: 'vassal.respond', offerId: 4, accept: false },
    { type: 'vassal.release', vassalId: 2 },
    { type: 'vassal.renounce', vassalId: 2_147_483_647 },
    { type: 'court.offer', office: 'grandMarshal', generalId: 30 },
    { type: 'court.respond', offerId: 5, accept: true },
    { type: 'court.dismiss', office: 'minister' },
    { type: 'court.resign' },
    { type: 'court.remit', vassalId: 2, months: 12 },
    { type: 'court.censure', nationId: 9 },
  ])
    expect(read({ requestId, payload })).toEqual({ requestId, payload });
  for (const invalid of [
    null,
    { requestId: 'not-uuid', payload: offer },
    { requestId, payload: offer, expectedUserId: 'x' },
    { requestId, payload: { ...offer, sourceNationId: 2 } },
    { requestId, payload: { ...offer, goldBp: 1.5 } },
    { requestId, payload: { ...offer, riceBp: 10_001 } },
    { requestId, payload: { ...offer, authority: 'SELF' } },
    { requestId, payload: { ...offer, targetNationId: 0 } },
    { requestId, payload: { type: 'vassal.respond', offerId: 4, accept: 'yes' } },
    { requestId, payload: { type: 'vassal.release', vassalId: 2_147_483_648 } },
    { requestId, payload: { type: 'court.offer', office: 'emperor', generalId: 30 } },
    { requestId, payload: { type: 'court.resign', office: 'minister' } },
    { requestId, payload: { type: 'court.remit', vassalId: 2, months: 13 } },
    { requestId, payload: { type: 'court.remit', vassalId: 2, months: 0 } },
    { requestId, payload: { type: 'throne.seize' } },
    { requestId, payload: [{ type: 'throne.ascend' }] },
  ])
    expect(read(invalid)).toBeNull();
  expect(readGovernancePending({ getItem: () => '{broken' }, 'key')).toBeNull();
  expect(governanceStorageKey('A', 'one')).not.toBe(governanceStorageKey('B', 'one'));
  expect(governanceStorageKey('A', 'one')).not.toBe(governanceStorageKey('A', 'two'));
  // 칸 순서가 달라도 같은 내용이다.
  expect(sameGovernancePayload(offer, { ...offer, type: 'vassal.offer' })).toBe(true);
  expect(sameGovernancePayload(offer, { ...offer, goldBp: 501 })).toBe(false);
});

it('T4-94 AC-P2-31 확인하지 못한 요청은 같은 번호·내용으로만 다시 접수하고 새 요청은 막는다', () => {
  const pending: GovernancePending = { requestId, payload: { type: 'throne.ascend' } };
  const base = { request: pending, pending, saved: pending, canSubmit: true, stale: false };
  expect(governanceModeAllowed('check', base)).toBe(true);
  expect(governanceModeAllowed('resubmit', base)).toBe(true);
  const fresh: GovernancePending = { requestId: other, payload: pending.payload };
  expect(governanceModeAllowed('submit', { ...base, request: fresh })).toBe(false);
  expect(governanceModeAllowed('submit', { ...base, request: fresh, pending: null })).toBe(false);
  expect(governanceModeAllowed('submit', { ...base, request: fresh, pending: null, saved: null })).toBe(true);
  expect(governanceModeAllowed('submit', { ...base, request: fresh, pending: null, saved: null, stale: true })).toBe(
    false,
  );
  expect(governanceModeAllowed('resubmit', { ...base, request: fresh })).toBe(false);
  expect(
    governanceModeAllowed('resubmit', { ...base, request: { requestId, payload: { type: 'throne.abdicate' } } }),
  ).toBe(false);
  // 권한이 없거나 탭 기록이 사라졌으면 상태 확인만 한다.
  expect(governanceModeAllowed('resubmit', { ...base, canSubmit: false })).toBe(false);
  expect(governanceModeAllowed('resubmit', { ...base, saved: null })).toBe(false);
  expect(governanceModeAllowed('check', { ...base, saved: null, canSubmit: false })).toBe(true);
});

it('T4-94 AC-P2-31 다른 탭이 바꾼 기록은 지우지 않는다', () => {
  const storage = memory();
  const mine: GovernancePending = { requestId, payload: { type: 'court.resign' } };
  writeGovernancePending(storage, 'key', { requestId: other, payload: mine.payload });
  expect(forgetGovernancePending(storage, 'key', mine)).toBe(false);
  expect(readGovernancePending(storage, 'key')?.requestId).toBe(other);
  writeGovernancePending(storage, 'key', mine);
  expect(forgetGovernancePending(storage, 'key', mine)).toBe(true);
  expect(readGovernancePending(storage, 'key')).toBeNull();
});

it('T4-95 AC-P2-32 새 기록은 처음 보낸 장수 id를 함께 두고, 장수 id 없는 예전 기록도 그대로 읽는다', () => {
  const storage = memory();
  const mine: GovernancePending = { requestId, generalId: 10, payload: { type: 'throne.ascend' } };
  writeGovernancePending(storage, 'key', mine);
  expect(JSON.parse(storage.getItem('key')!)).toEqual({ requestId, generalId: 10, payload: { type: 'throne.ascend' } });
  expect(readGovernancePending(storage, 'key')).toEqual(mine);
  // 예전 기록(장수 id 없음)은 읽되 generalId 칸을 만들지 않는다.
  const legacy = read({ requestId, payload: { type: 'throne.ascend' } });
  expect(legacy).toEqual({ requestId, payload: { type: 'throne.ascend' } });
  expect(legacy && Object.hasOwn(legacy, 'generalId')).toBe(false);
  for (const generalId of [0, -1, 1.5, '10', null, 2_147_483_648])
    expect(read({ requestId, generalId, payload: { type: 'throne.ascend' } }), String(generalId)).toBeNull();

  // 같은 번호·내용이라도 보낸 장수가 다르면 같은 요청이 아니다. 재접수·지우기 모두 하지 않는다.
  const moved: GovernancePending = { ...mine, generalId: 11 };
  const base = { request: mine, pending: mine, saved: mine, canSubmit: true, stale: false };
  expect(governanceModeAllowed('resubmit', base)).toBe(true);
  expect(governanceModeAllowed('resubmit', { ...base, request: moved })).toBe(false);
  expect(governanceModeAllowed('resubmit', { ...base, saved: moved })).toBe(false);
  expect(governanceModeAllowed('check', { ...base, request: moved })).toBe(false);
  expect(forgetGovernancePending(storage, 'key', moved)).toBe(false);
  expect(readGovernancePending(storage, 'key')).toEqual(mine);

  // 장수가 바뀌었다고 보는 경우는 기록에 장수 id가 있고 지금 장수를 알며 둘이 다를 때뿐이다.
  expect(governanceActorChanged(mine, 11)).toBe(true);
  expect(governanceActorChanged(mine, 10)).toBe(false);
  expect(governanceActorChanged(mine, null)).toBe(false);
  expect(governanceActorChanged(legacy!, 11)).toBe(false);
});
