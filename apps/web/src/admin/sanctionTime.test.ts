import { describe, expect, it } from 'vitest';
import { parseSanctionExpiry } from './sanctionTime';

describe('제재 만료의 한국 시각 입력과 UTC API 계약', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  it('한국 자정의 전날 UTC 날짜와 연도 경계를 유지한다', () => {
    expect(parseSanctionExpiry('2026-10-30T00:00', now)).toEqual({ ok: true, iso: '2026-10-29T15:00:00.000Z' });
    expect(parseSanctionExpiry('2027-01-01T00:01', now)).toEqual({ ok: true, iso: '2026-12-31T15:01:00.000Z' });
  });
  it('실제 윤일을 받으며 자동 보정된 날짜와 잘못된 시각은 거부한다', () => {
    expect(parseSanctionExpiry('2028-02-29T09:30', now)).toEqual({ ok: true, iso: '2028-02-29T00:30:00.000Z' });
    for (const value of [
      '2027-02-29T09:30',
      '2028-02-30T09:30',
      '2026-13-01T00:00',
      '2026-12-01T24:00',
      '2026-12-01T12:60',
      '',
      '2026-12-01T12:00Z',
    ])
      expect(parseSanctionExpiry(value, now).ok).toBe(false);
  });
  it('현재와 같은 분·과거는 거부하고 미래 분만 전송한다', () => {
    expect(parseSanctionExpiry('2026-10-29T09:00', now).ok).toBe(false);
    expect(parseSanctionExpiry('2026-10-29T08:59', now).ok).toBe(false);
    expect(parseSanctionExpiry('2026-10-29T09:01', now)).toEqual({ ok: true, iso: '2026-10-29T00:01:00.000Z' });
  });
});
