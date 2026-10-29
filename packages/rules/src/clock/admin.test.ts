import { describe, expect, it } from 'vitest';
import { applyAdminClockRecord, validateAdminClockRecord, adminClockRejectMessages } from './admin';
import type { RecordedInput, ReplayState } from '../replay';

function record(action = 'pause'): RecordedInput {
  return {
    sequence: 7,
    tick: 120,
    generalId: null,
    kind: 'admin.world.' + action,
    status: 'APPLIED',
    payload: { version: 1, reason: '운영 점검' },
    result: {
      version: 1,
      before: {
        status: action === 'start' ? 'PREOPEN' : action === 'pause' ? 'RUNNING' : 'PAUSED',
        tick: action === 'pause' ? 100 : 120,
        revision: 3,
      },
      after: { status: action === 'pause' ? 'PAUSED' : 'RUNNING', tick: 120, revision: 4 },
      at: '2026-10-29T02:00:00.000Z',
    },
  };
}
describe('T3-05 AC-M3-04 외부 시계 입력 기록', () => {
  it.each(['start', 'pause', 'resume'])('%s는 정확한 상태·순번·tick을 대조하고 게임 상태를 보존한다', (action) => {
    const input = record(action),
      replay = {
        state: { sentinel: [1, 2, 3] },
        turns: { 1: [{ commandKey: 'rest', args: {} }] },
      } as unknown as ReplayState;
    const before = structuredClone(replay);
    expect(applyAdminClockRecord(replay, input)).toBe(replay);
    expect(replay).toEqual(before);
  });
  it.each(Object.entries(adminClockRejectMessages))('기각 %s는 정해진 공개 문구만 받는다', (code, message) => {
    const input = { ...record(), status: 'REJECTED' as const, result: { code, message } };
    expect(() => validateAdminClockRecord(input)).not.toThrow();
    expect(() => validateAdminClockRecord({ ...input, result: { code, message: 'private failure' } })).toThrow();
    expect(() => validateAdminClockRecord({ ...input, result: { code, message, secret: 'private' } })).toThrow();
  });
  it('종류 와일드카드·장수 ID·누락 tick·역행·틀린 조치·추가 필드를 거부한다', () => {
    const input = record(),
      result = input.result as Record<string, unknown>;
    for (const value of [
      { ...input, kind: 'admin.world.reset' },
      { ...input, generalId: 1 },
      { ...input, tick: null },
      { ...input, sequence: 0 },
      { ...input, sequence: 2_147_483_648 },
      { ...input, privateField: 'unexpected' },
      { ...input, result: { ...result, after: { status: 'PAUSED', tick: 99, revision: 4 } } },
      { ...input, result: { ...result, after: { status: 'PAUSED', tick: 120, revision: 5 } } },
      { ...input, result: { ...result, before: { status: 'PAUSED', tick: 100, revision: 3 } } },
      { ...input, payload: { version: 1, reason: '점검', actorUserId: 'forged' } },
      { ...input, payload: { version: 1, reason: '운영\n점검' } },
    ])
      expect(() => validateAdminClockRecord(value)).toThrow();
  });
});
