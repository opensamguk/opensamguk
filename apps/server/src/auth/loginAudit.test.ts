import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceCookieOptions, prepareLoginAudit, resolveLoginAudit } from './loginAudit';

describe('AC-M3-05 로그인 조사 식별자', () => {
  const key = randomBytes(32).toString('hex');
  const supplied = { key, version: 1 };
  const config = () => resolveLoginAudit({}, false, supplied)!;

  it('개발 미설정은 비수집이며 운영에는 키와 버전이 모두 필요하다', () => {
    expect(resolveLoginAudit({}, false)).toBeNull();
    expect(resolveLoginAudit({}, false, null)).toBeNull();
    expect(() => resolveLoginAudit({}, true)).toThrow('로그인 조사 키 설정');
    expect(() => resolveLoginAudit({}, true, null)).toThrow('로그인 조사 키 설정');
    expect(() => resolveLoginAudit({ AUDIT_HASH_KEY: key }, false)).toThrow();
    expect(() => resolveLoginAudit({ AUDIT_HASH_KEY_VERSION: '1' }, false)).toThrow();
    expect(resolveLoginAudit({ AUDIT_HASH_KEY: key, AUDIT_HASH_KEY_VERSION: '7' }, true)?.version).toBe(7);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    '잘못된 키 버전 %s를 거부한다',
    (version) => {
      expect(() => resolveLoginAudit({}, false, { key, version })).toThrow('로그인 조사 키 설정');
    },
  );

  it('짧은 키를 거부하고 오류에 주어진 비밀을 포함하지 않는다', () => {
    const short = randomBytes(8).toString('hex');
    try {
      resolveLoginAudit({}, false, { key: short, version: 1 });
      throw new Error('잘못된 설정을 허용했습니다.');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('로그인 조사 키 설정을 확인하세요.');
      expect((error as Error).message).not.toContain(short);
    }
  });

  it('전체 IP와 무작위 쿠키를 각각 표준 HMAC-SHA256으로 기록한다', () => {
    const ip = '2001:db8:1234:5678::90';
    const did = randomBytes(16).toString('hex');
    const prepared = prepareLoginAudit(config(), ip, did);
    const digest = (value: string) => createHmac('sha256', key).update(value, 'utf8').digest('hex');
    expect(prepared).toEqual({ token: did, ipHash: digest(ip), deviceHash: digest(did), hashKeyVersion: 1 });
    expect(prepared.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.deviceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepareLoginAudit(config(), '2001:db8:1234:5678::91', did).ipHash).not.toBe(prepared.ipHash);
    expect(prepared.deviceHash).not.toBe(prepared.ipHash);
  });

  it('키 교체 뒤 같은 원본도 다른 해시이며 버전이 함께 바뀐다', () => {
    const rotated = resolveLoginAudit({}, false, { key: randomBytes(32).toString('hex'), version: 2 })!;
    const did = randomBytes(16).toString('hex');
    const first = prepareLoginAudit(config(), '192.0.2.1', did);
    const second = prepareLoginAudit(rotated, '192.0.2.1', did);
    expect(second.ipHash).not.toBe(first.ipHash);
    expect(second.deviceHash).not.toBe(first.deviceHash);
    expect(second.hashKeyVersion).toBe(2);
  });

  it.each([undefined, '', 'g'.repeat(32), '0'.repeat(31), '0'.repeat(33), 'A'.repeat(32)])(
    '잘못된 쿠키 %s를 새 128비트 난수로 교체한다',
    (device) => {
      const first = prepareLoginAudit(config(), '192.0.2.1', device);
      const second = prepareLoginAudit(config(), '192.0.2.1', device);
      expect(first.token).toMatch(/^[0-9a-f]{32}$/);
      expect(second.token).not.toBe(first.token);
      expect(first.deviceHash).not.toBe(second.deviceHash);
      expect(first.ipHash).toBe(second.ipHash);
    },
  );

  it('기기 쿠키는 스크립트 접근을 막고 1년간 같은 출처 경로에 둔다', () => {
    expect(deviceCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 31_536_000,
    });
    expect(deviceCookieOptions(false).secure).toBe(false);
  });
});
