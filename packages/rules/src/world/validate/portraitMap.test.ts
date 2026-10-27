import { describe, expect, it } from 'vitest';
import { validatePortraitMap } from './portraitMap';
import { codes } from './testFixtures';

describe('T4-76 초상 대응표 검증', () => {
  it('ID 경계를 보존하고 생성기 기록을 입력에서 지우지 않는다', () => {
    const raw = { portraits: { 가: 10001, 나: 11000 }, stats: { count: 2 } };
    expect(validatePortraitMap(raw)).toMatchObject({ status: 'pass', issues: [] });
    expect(raw.stats.count).toBe(2);
  });
  it.each([10000, 11009, 10001.5])('잘못된 ID %i를 거부한다', (id) => {
    expect(codes(validatePortraitMap({ portraits: { 가: id } }))).toEqual(['shape-invalid']);
  });
  it('record 키 삽입 순서가 달라도 구조 오류 순서가 같다', () => {
    expect(validatePortraitMap({ portraits: { z: 1, a: 2 } })).toEqual(
      validatePortraitMap({ portraits: { a: 2, z: 1 } }),
    );
  });
});
