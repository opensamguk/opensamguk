import { describe, expect, it } from 'vitest';
import { auditFilter, koreanDate, searchFilter } from './filters';

function data(values: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}
describe('관리자 조회 입력 경계', () => {
  it('한국 자정과 윤일을 실제 UTC로 옮기며 호스트 시간대에 의존하지 않는다', () => {
    expect(koreanDate('2026-10-28T00:00')).toBe('2026-10-27T15:00:00.000Z');
    expect(koreanDate('2024-02-29T23:59')).toBe('2024-02-29T14:59:00.000Z');
    for (const value of [
      '2026-02-29T12:00',
      '2026-04-31T12:00',
      '2026-10-28T24:00',
      '2026-10-28T12:60',
      '2026-10-28T12:00Z',
    ])
      expect(() => koreanDate(value)).toThrow();
  });
  it('기간 역전과 잘못된 UUID를 전송 전에 거부하고 빈 필터를 생략한다', () => {
    expect(auditFilter(data({ action: ' user.search ', targetId: ' a ', from: '', worldId: '' }))).toEqual({
      action: 'user.search',
      targetId: 'a',
    });
    expect(() => auditFilter(data({ from: '2026-10-29T00:00', to: '2026-10-28T00:00' }))).toThrow();
    expect(() => auditFilter(data({ actorUserId: 'someone' }))).toThrow();
    expect(() => auditFilter(data({ action: '<script>' }))).toThrow();
  });
  it('정식 월드 이름 검색과 이메일의 특수문자를 그대로 전달한다', () => {
    expect(
      searchFilter(data({ kind: 'general', worldId: '12345678-1234-4234-8234-123456789012', generalName: ' 장수%_ ' })),
    ).toEqual({ query: { worldId: '12345678-1234-4234-8234-123456789012', generalName: '장수%_' } });
    expect(searchFilter(data({ query: ' a%_\\ ' }))).toEqual({ query: 'a%_\\' });
    expect(() => searchFilter(data({ query: 'ab' }))).toThrow();
    expect(() => searchFilter(data({ kind: 'general', worldId: 'invalid', generalName: '장수' }))).toThrow();
  });
});
