import { describe, expect, it } from 'vitest';
import { creationBlock } from './creationBlock';

describe('T2-03 / AC-M2-02 장수 생성 판정', () => {
  it.each(['RUNNING', 'PREOPEN', 'PAUSED', 'ENDED'] as const)(
    '내 장수가 있으면 %s에서도 장수 있음이 먼저다',
    (status) => {
      expect(creationBlock({ status, hasGeneral: true, hasPending: true })).toEqual({
        code: 'ALREADY_EXISTS',
        reason: null,
      });
    },
  );

  it.each([
    ['PAUSED', '멈춘 월드입니다'],
    ['ENDED', '끝난 월드입니다'],
    ['PREOPEN', '아직 열리지 않은 월드입니다'],
  ] as const)('%s에서는 생성 접수보다 월드 상태가 먼저다', (status, reason) => {
    for (const hasPending of [false, true])
      expect(creationBlock({ status, hasGeneral: false, hasPending })).toEqual({ code: 'WORLD_CLOSED', reason });
  });

  it('열린 월드의 내 접수는 대기 중이고 엔진이 처리하는 접수는 막지 않는다', () => {
    expect(creationBlock({ status: 'RUNNING', hasGeneral: false, hasPending: true })).toEqual({
      code: 'PENDING',
      reason: '장수를 만드는 중입니다',
    });
    expect(creationBlock({ status: 'RUNNING', hasGeneral: false, hasPending: false })).toBeNull();
  });
});

it('AC-INT-24 생성 닫기는 새 접수·대기 생성을 막고 기존 장수와 월드 상태 판정을 보존한다', () => {
  for (const hasPending of [false, true])
    expect(creationBlock({ status: 'RUNNING', hasGeneral: false, hasPending, entryOpen: false })).toEqual({
      code: 'ENTRY_CLOSED',
      reason: '지금은 새 장수를 받지 않습니다',
    });
  expect(creationBlock({ status: 'RUNNING', hasGeneral: true, hasPending: false, entryOpen: false })).toEqual({
    code: 'ALREADY_EXISTS',
    reason: null,
  });
  expect(creationBlock({ status: 'PAUSED', hasGeneral: false, hasPending: false, entryOpen: false })!.code).toBe(
    'WORLD_CLOSED',
  );
});
