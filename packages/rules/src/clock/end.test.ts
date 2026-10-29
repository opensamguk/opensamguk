import { describe, expect, it } from 'vitest';
import {
  ADMIN_END_KIND,
  adminEndPayloadSchema,
  adminEndRejectMessages,
  applyAdminEndRecord,
  validateAdminEndRecord,
  checkAdminEndOrigin,
} from './end';
import type { RecordedInput, ReplayState } from '../replay';
import { checkReplayOrigin } from '../ruleRegistry';

function record(): RecordedInput {
  return {
    sequence: 1,
    tick: 0,
    generalId: null,
    kind: ADMIN_END_KIND,
    status: 'APPLIED',
    payload: { version: 1, confirmName: '정식 월드', expectedRevision: 2, reason: '종료 확인' },
    result: {
      version: 1,
      before: { status: 'PAUSED', tick: 0, revision: 2 },
      after: { status: 'ENDED', tick: 0, revision: 3 },
      at: '2026-10-29T00:00:00.000Z',
      finalStateHash: 'a'.repeat(64),
    },
  };
}
describe('ADMIN-END AC-M3-04 엄격 입력 기록', () => {
  it('이름을 정확히 보존하고 사유만 정리한다', () => {
    expect(
      adminEndPayloadSchema.parse({ version: 1, confirmName: ' 월드 ', expectedRevision: 0, reason: ' 확인 ' }),
    ).toEqual({ version: 1, confirmName: ' 월드 ', expectedRevision: 0, reason: '확인' });
  });
  it('기존 긴 월드명도 확인 문자열을 줄이거나 바꾸지 않는다', () => {
    const confirmName = '긴 월드 이름 '.repeat(100);
    expect(
      adminEndPayloadSchema.parse({ version: 1, confirmName, expectedRevision: 2, reason: '확인' }).confirmName,
    ).toBe(confirmName);
  });
  it('적용은 난수·예약·게임 상태와 같은 사본을 반환한다', () => {
    const state = {
      state: { seed: 'same' },
      turns: { 1: [{ commandKey: 'rest', args: {} }] },
    } as unknown as ReplayState;
    const before = structuredClone(state);
    expect(applyAdminEndRecord(state, record())).toBe(state);
    expect(state).toEqual(before);
  });
  it.each(Object.entries(adminEndRejectMessages))('기각 %s는 정해진 문구만 받는다', (code, message) => {
    expect(() => validateAdminEndRecord({ ...record(), status: 'REJECTED', result: { code, message } })).not.toThrow();
    expect(() =>
      validateAdminEndRecord({ ...record(), status: 'REJECTED', result: { code, message: 'private' } }),
    ).toThrow();
  });
  it('손상·와일드카드·진행 tick·revision·hash·추가 필드를 거부한다', () => {
    const value = record(),
      result = value.result as Record<string, unknown>,
      payload = value.payload as Record<string, unknown>;
    for (const changed of [
      { kind: 'admin.world.reset' },
      { generalId: 1 },
      { tick: null },
      { tick: -1 },
      { sequence: 0 },
      { status: 'PENDING' },
      { extra: true },
      { payload: { ...payload, actor: 'forged' } },
      { payload: { ...payload, expectedRevision: 3 } },
      { payload: { ...payload, reason: '금지\n문자' } },
      { result: { ...result, finalStateHash: 'not-a-hash' } },
      { result: { ...result, extra: true } },
      { result: { ...result, after: { status: 'ENDED', tick: 1, revision: 3 } } },
      { result: { ...result, after: { status: 'ENDED', tick: 0, revision: 4 } } },
      { result: { ...result, before: { status: 'RUNNING', tick: 0, revision: 2 } } },
    ])
      expect(() => validateAdminEndRecord({ ...value, ...changed } as RecordedInput)).toThrow();
  });
  it('현재 format 숫자만 바꾼 구월드는 인정하지 않는다', () => {
    for (const replayOrigin of [null, { version: 1, initial: {} }, { version: 6, initial: {} }])
      expect(() =>
        checkAdminEndOrigin({ replayFormat: 3, ruleFeatures: [], replayOrigin }, checkReplayOrigin, () => ''),
      ).toThrow();
  });
});
