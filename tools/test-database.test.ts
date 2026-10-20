import { describe, expect, it } from 'vitest';
import { testDatabaseUrl } from './test-database';

describe('통합 테스트 DB 보호', () => {
  it('기본 DB는 개발 DB와 다른 _test DB다', () => {
    expect(testDatabaseUrl({}).pathname).toBe('/opensamguk_test');
  });
  it('일반 DB나 SQL 식별자로 쓸 수 없는 이름을 거부한다', () => {
    for (const name of ['opensamguk', 'postgres', 'unsafe%22_test']) {
      expect(() => testDatabaseUrl({ TEST_DATABASE_URL: `postgresql://localhost/${name}` })).toThrow();
    }
  });
  it('개발 DB와 같은 대상이면 호스트 별칭·인증 정보와 무관하게 거부한다', () => {
    expect(() => testDatabaseUrl({
      TEST_DATABASE_URL: 'postgresql://test@localhost/shared_test',
      DATABASE_URL: 'postgresql://dev@127.0.0.1:5432/shared_test',
    })).toThrow('달라야');
  });
});
