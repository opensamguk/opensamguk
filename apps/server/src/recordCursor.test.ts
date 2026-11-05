import { expect, it } from 'vitest';
import { decodeRecordCursor, encodeRecordCursor, generalLogCursor } from './recordCursor';

it('AC-INT-23 같은 시각의 bigint 기록 커서는 정확하게 왕복하고 변형을 거절한다', () => {
  const tuple: [number, string] = [2_147_483_647, '9223372036854775807'];
  expect(decodeRecordCursor(encodeRecordCursor(tuple), generalLogCursor)).toEqual(tuple);
  for (const value of [
    '%%%',
    'W10=',
    encodeRecordCursor([0, '0']),
    encodeRecordCursor([-1, '1']),
    encodeRecordCursor([0, '9223372036854775808']),
    encodeRecordCursor([0, '1', 2]),
    Buffer.from('[0, "1"]').toString('base64url'),
  ])
    expect(() => decodeRecordCursor(value, generalLogCursor)).toThrow('이전 페이지');
});
