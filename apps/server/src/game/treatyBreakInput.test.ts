import { describe, expect, it } from 'vitest';
import { breakInput, trustInput } from './treatyBreakInput';

const worldId = 'treaty-input-world';
const requestId = 'ef45d9b2-1dc3-4ea7-82f5-67800ce9ac76';

describe('T2-07 / AC-M2-06 파기·신의 외곽 입력', () => {
  it('월드와 요청 식별자를 읽고 신의 조회는 월드만 받는다', () => {
    const input = { worldId, requestId, treatyId: '12' };
    expect(breakInput.parse(input)).toEqual(input);
    expect(trustInput.parse({ worldId })).toEqual({ worldId });
  });

  it.each([{ generalId: 1 }, { nationId: 1 }, { unexpected: true }])(
    '파기와 신의 조회에서 남는 칸을 거부한다 (%j)',
    (extra) => {
      expect(breakInput.safeParse({ worldId, requestId, treatyId: '12', ...extra }).success).toBe(false);
      expect(trustInput.safeParse({ worldId, ...extra }).success).toBe(false);
    },
  );

  it.each(['', '12', 'not-a-uuid', null, 12])('잘못된 요청 식별자를 거부한다 (%j)', (invalid) => {
    expect(breakInput.safeParse({ worldId, requestId: invalid, treatyId: '12' }).success).toBe(false);
  });

  it.each(['', 'w'.repeat(65), null, 12])('잘못된 월드 식별자를 거부한다 (%j)', (invalid) => {
    expect(breakInput.safeParse({ worldId: invalid, requestId, treatyId: '12' }).success).toBe(false);
    expect(trustInput.safeParse({ worldId: invalid }).success).toBe(false);
  });

  it.each([12, '01'])('조약 ID 정규화는 중앙 normalizer에 남긴다 (%j)', (treatyId) => {
    expect(breakInput.parse({ worldId, requestId, treatyId })).toEqual({ worldId, requestId, treatyId });
  });

  it('신의 조회에는 요청·조약·쪽 식별자를 받지 않는다', () => {
    for (const extra of [{ requestId }, { treatyId: '12' }, { cursor: '12' }])
      expect(trustInput.safeParse({ worldId, ...extra }).success).toBe(false);
  });
});
