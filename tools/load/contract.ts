// AC-M3-07 / T3-11. smoke 수치가 정식 인수 조건을 덮지 않는다.
export const LOAD_CONTRACT = Object.freeze({
  worlds: 2,
  historicalGenerals: 491,
  humansPerWorld: 109,
  accounts: 218,
  generalsPerWorld: 600,
  usersPerWorld: 50,
  concurrentUsers: 100,
  warmupMs: 120_000,
  measurementMs: 900_000,
  minimumThinkMs: 1_000,
  maximumThinkMs: 3_000,
  apiP95LimitMs: 300,
  turnLagLimitMs: 10_000,
});

export const LOAD_FEATURES = Object.freeze([
  'campaign-assignment-v2',
  'campaign-v1',
  'city-resources-v1',
  'five-stats',
  'operational-map',
  'personnel',
  'policy',
  'stratagem-basic',
  'treaty',
]);

export const LOAD_RESOURCES = Object.freeze({
  scenario: 'integration191',
  map: 'integration',
  unitSet: 'basic',
  statRules: 'five-stats',
  portraitMap: '191-map',
});

// 실제 정책 승인이 아니다. 전용 부하 서버/DB에서만 쓰는 인증 경로 고정물이다.
export const LOAD_FIXTURE_POLICY = Object.freeze({
  terms: Object.freeze({
    version: 'load-fixture-v1',
    effectiveAt: '2000-01-01T00:00:00.000Z',
    bodyText: '부하 검사 전용 약관 고정물입니다. 운영 정책이 아닙니다.',
  }),
  privacy: Object.freeze({
    version: 'load-fixture-v1',
    effectiveAt: '2000-01-01T00:00:00.000Z',
    bodyText: '부하 검사 전용 동의 고정물입니다. 운영 정책이 아닙니다.',
  }),
});

export function loadDatabaseName(runId: string): string {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error('LOAD_RUN_ID_INVALID');
  return `opensamguk_load_${runId}_test`;
}

export function loadWorldPlans(runId: string) {
  loadDatabaseName(runId);
  return ([1, 2] as const).map((turnTermMinutes, index) => ({
    label: index === 0 ? ('A' as const) : ('B' as const),
    turnTermMinutes,
    seed: `load-v1-${runId}-${index}`,
    humanNames: Array.from(
      { length: LOAD_CONTRACT.humansPerWorld },
      (_, offset) => `부하${index + 1}${String(offset + 1).padStart(3, '0')}`,
    ),
  }));
}
