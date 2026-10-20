const DEFAULT_TEST_DATABASE_URL = 'postgresql://opensamguk:opensamguk@127.0.0.1:5433/opensamguk_test';

export function testDatabaseUrl(env: Record<string, string | undefined>): URL {
  const url = new URL(env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  const databaseName = url.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^[a-z][a-z0-9_]*_test$/.test(databaseName)) {
    throw new Error('통합 테스트 DB 이름은 소문자·숫자·밑줄로 구성하고 _test로 끝나야 합니다.');
  }
  if (env.DATABASE_URL) {
    const development = new URL(env.DATABASE_URL);
    const host = (value: URL) => value.hostname === 'localhost' ? '127.0.0.1' : value.hostname;
    if (host(development) === host(url) && (development.port || '5432') === (url.port || '5432') && development.pathname === url.pathname) {
      throw new Error('통합 테스트 DB와 개발 DATABASE_URL은 달라야 합니다.');
    }
  }
  return url;
}
