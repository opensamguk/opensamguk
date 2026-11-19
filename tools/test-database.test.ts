import { describe, expect, it, vi } from 'vitest';
import { testDatabaseUrl } from './test-database';

describe('통합 테스트 DB 보호', () => {
  it('AC-INT-28 전용 DB 실행 중에는 시험이 만든 다른 DB 이름도 거부한다', () => {
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://localhost/opensamguk_ci_green');
    try {
      expect(() => testDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://localhost/other_test' })).toThrow('외의 DB');
      expect(testDatabaseUrl(process.env).pathname).toBe('/opensamguk_ci_green');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('AC-INT-28 CI 복구 전용 DB 이름만 예외로 허용한다', () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://localhost/opensamguk_ci_green' }).pathname).toBe(
      '/opensamguk_ci_green',
    );
    for (const name of ['another_ci_green', 'opensamguk_ci_green_other'])
      expect(() => testDatabaseUrl({ TEST_DATABASE_URL: `postgresql://localhost/${name}` })).toThrow();
    expect(
      testDatabaseUrl({
        TEST_DATABASE_URL: 'postgresql://localhost/opensamguk_ci_green',
        DATABASE_URL: 'postgresql://localhost/opensamguk_ci_green',
      }),
    ).toHaveProperty('pathname', '/opensamguk_ci_green');
  });
  it('기본 DB는 _test DB다', () => {
    expect(testDatabaseUrl({}).pathname).toBe('/opensamguk_test');
  });
  it('일반 DB나 SQL 식별자로 쓸 수 없는 이름을 거부한다', () => {
    for (const name of ['opensamguk', 'postgres', 'unsafe%22_test']) {
      expect(() => testDatabaseUrl({ TEST_DATABASE_URL: `postgresql://localhost/${name}` })).toThrow();
    }
  });
  it('CI는 두 URL이 같은 시험 DB를 가리켜도 허용한다', () => {
    expect(
      testDatabaseUrl({
        TEST_DATABASE_URL: 'postgresql://test@localhost/shared_test',
        DATABASE_URL: 'postgresql://dev@127.0.0.1:5432/shared_test',
      }),
    ).toHaveProperty('pathname', '/shared_test');
  });
});
