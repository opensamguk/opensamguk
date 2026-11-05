import { describe, expect, it } from 'vitest';
import {
  forgetLineagePending,
  lineageModeAllowed,
  lineageStorageKey,
  ownerCurrent,
  readLineagePending,
  writeLineagePending,
  type LineagePending,
} from './lineageRequestState';

// 탭 기록과 대화상자 주인 판정만 본다. 접수·재생 판정은 서버·엔진 시험이 맡는다.
const USER = '11111111-1111-4111-8111-111111111111';
const WORLD = 'world-one';
const requestId = '12345678-1234-4234-8234-123456789abc';
const preview = {
  heirId: 21,
  officerLevel: 12,
  gold: 300,
  rice: 200,
  crew: 0,
  unitIds: [],
  keptRetinue: [],
  releasedRetinue: [4],
  cancelledOrders: [],
  cancelledOffers: [{ kind: 'RETINUE' as const, id: '9' }],
  governance: { throne: false, courtOffice: null, vassalIds: [] },
};
const confirm: LineagePending = {
  requestId,
  generalId: 10,
  payload: { type: 'succession.confirm', heirGeneralId: 21, expected: preview },
};

it('T4-23 AC-P2-32 장비 미리보기는 탭 복원 뒤에도 서버의 칸 순서와 원장을 보존한다', () => {
  const storage = memory(),
    key = lineageStorageKey(USER, WORLD);
  const equipment = {
    from: { weapon: 'weapon_06', book: 'book_03' },
    heir: { horse: 'horse_01' },
    inherited: { horse: 'horse_01', weapon: 'weapon_06', book: 'book_03' },
  };
  const expected = { equipment, ...preview };
  storage.setItem(
    key,
    JSON.stringify({
      ...confirm,
      payload: {
        type: 'succession.confirm',
        heirGeneralId: 21,
        expected: Object.fromEntries(Object.entries(expected).reverse()),
      },
    }),
  );
  const restored = readLineagePending(storage, key);
  expect(restored?.payload.type).toBe('succession.confirm');
  expect(JSON.stringify(restored?.payload.type === 'succession.confirm' && restored.payload.expected)).toBe(
    JSON.stringify(expected),
  );
});

it.each([
  undefined,
  null,
  {},
  { from: {}, heir: null, inherited: null },
  { from: { weapon: 'horse_01' }, heir: null, inherited: null },
  { from: { weapon: 'weapon_07' }, heir: null, inherited: null },
  { from: { extra: 'weapon_01' }, heir: null, inherited: null },
  { from: null, heir: null, inherited: null, extra: true },
])('T4-23 AC-P2-32 잘못된 장비 미리보기 %j는 복원하지 않는다', (equipment) => {
  const storage = memory(),
    key = lineageStorageKey(USER, WORLD);
  storage.setItem(
    key,
    JSON.stringify({
      ...confirm,
      payload: { type: 'succession.confirm', heirGeneralId: 21, expected: { equipment, ...preview } },
    }),
  );
  // JSON에 없는 선택 필드는 기존 장비 비활성 월드의 미리보기다.
  expect(readLineagePending(storage, key) === null).toBe(equipment !== undefined);
});
function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe('T4-95 AC-P2-32 가문 요청 탭 기록', () => {
  it('보낸 장수 id까지 함께 저장하고 같은 모양으로만 다시 읽는다', () => {
    const storage = memory(),
      key = lineageStorageKey(USER, WORLD);
    writeLineagePending(storage, key, confirm);
    expect(readLineagePending(storage, key)).toEqual(confirm);
    for (const broken of [
      { requestId, payload: confirm.payload },
      { ...confirm, generalId: 0 },
      { ...confirm, extra: 1 },
      { ...confirm, payload: { ...confirm.payload, heirGeneralId: 22 } },
      { ...confirm, payload: { type: 'marriage.propose', targetGeneralId: 3, accept: true } },
    ]) {
      storage.setItem(key, JSON.stringify(broken));
      expect(readLineagePending(storage, key)).toBeNull();
    }
  });

  it('미리보기는 저장된 칸 순서와 상관없이 서버 스키마 순서로 다시 만든다', () => {
    const storage = memory(),
      key = lineageStorageKey(USER, WORLD);
    const reversed = Object.fromEntries(Object.entries(preview).reverse());
    storage.setItem(key, JSON.stringify({ ...confirm, payload: { ...confirm.payload, expected: reversed } }));
    const saved = readLineagePending(storage, key)!;
    expect(saved.payload.type).toBe('succession.confirm');
    expect(JSON.stringify(saved.payload.type === 'succession.confirm' && saved.payload.expected)).toBe(
      JSON.stringify(preview),
    );
  });

  it('같은 요청 재접수와 기록 지우기는 처음 보낸 장수 id까지 같아야 한다', () => {
    const storage = memory(),
      key = lineageStorageKey(USER, WORLD);
    writeLineagePending(storage, key, confirm);
    const heir = { ...confirm, generalId: 21 };
    expect(
      lineageModeAllowed('resubmit', {
        request: heir,
        pending: confirm,
        saved: confirm,
        canSubmit: true,
        stale: false,
      }),
    ).toBe(false);
    expect(
      lineageModeAllowed('resubmit', {
        request: confirm,
        pending: confirm,
        saved: confirm,
        canSubmit: true,
        stale: false,
      }),
    ).toBe(true);
    expect(forgetLineagePending(storage, key, heir)).toBe(false);
    expect(readLineagePending(storage, key)).toEqual(confirm);
    expect(forgetLineagePending(storage, key, confirm)).toBe(true);
    expect(readLineagePending(storage, key)).toBeNull();
  });

  it('대화상자는 같은 계정·같은 세션이어도 장수가 바뀌었으면(계승) 보내지 않는다', () => {
    const owner = { userId: USER, session: 3, actorId: 10 };
    expect(ownerCurrent(owner, { userId: USER, session: 3, actorId: 10 })).toBe(true);
    expect(ownerCurrent(owner, { userId: USER, session: 3, actorId: 21 })).toBe(false);
    expect(ownerCurrent(owner, { userId: USER, session: 4, actorId: 10 })).toBe(false);
    expect(ownerCurrent(owner, { userId: '22222222-2222-4222-8222-222222222222', session: 3, actorId: 10 })).toBe(
      false,
    );
    expect(ownerCurrent(owner, null)).toBe(false);
  });
});
