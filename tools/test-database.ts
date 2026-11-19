const DEFAULT_TEST_DATABASE_URL = 'postgresql://opensamguk:opensamguk@127.0.0.1:5433/opensamguk_test';

// CI 복구에서는 파일별 생성·정리 시험도 담당자에게 배정된 DB 하나만 쓴다.
export function ciGreenDatabaseName(fallback: string): string {
  const name = process.env.CI_GREEN_DATABASE;
  if (!name) return fallback;
  if (
    !/^opensamguk_ci_green_[a-zA-Z0-9]+_test$/.test(name) ||
    new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL).pathname !== `/${name}`
  )
    throw new Error('CI 복구 전용 DB 이름과 시험 연결이 다릅니다.');
  return name;
}

export function testDatabaseUrl(env: Record<string, string | undefined>): URL {
  const url = new URL(env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  const databaseName = url.pathname.slice(1);
  const selectedDatabase = process.env.TEST_DATABASE_URL;
  if (
    selectedDatabase &&
    new URL(selectedDatabase).pathname === '/opensamguk_ci_green' &&
    databaseName !== 'opensamguk_ci_green'
  ) {
    throw new Error('CI 복구 시험은 opensamguk_ci_green 외의 DB를 사용할 수 없습니다.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    (!/^[a-z][a-zA-Z0-9_]*_test$/.test(databaseName) && databaseName !== 'opensamguk_ci_green')
  ) {
    throw new Error('통합 테스트 DB는 _test로 끝나는 이름 또는 opensamguk_ci_green이어야 합니다.');
  }
  if (env.DATABASE_URL) {
    const development = new URL(env.DATABASE_URL);
    const host = (value: URL) => (value.hostname === 'localhost' ? '127.0.0.1' : value.hostname);
    if (
      host(development) === host(url) &&
      (development.port || '5432') === (url.port || '5432') &&
      development.pathname === url.pathname
    ) {
      throw new Error('통합 테스트 DB와 개발 DATABASE_URL은 달라야 합니다.');
    }
  }
  return url;
}
