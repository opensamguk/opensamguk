// CI의 각 묶음은 자기 PostgreSQL 서비스를 쓴다. 로컬 기본 실행은 전체를 직렬 검사한다.
export const ENGINE_INTEGRATION_FILES = [
  'tools/scenarios.integration.test.ts',
  'apps/engine/src/supervisor.integration.test.ts',
  'apps/engine/src/accelerated.integration.test.ts',
  'apps/engine/src/season.integration.test.ts',
  'apps/engine/src/lease.integration.test.ts',
  // INT-01/AC-INT-01: 권한을 기록하지 않는 긴 PG 검사를 옮겨 API의 전역 대조를 한곳에 유지한다.
  'tools/int18-city-resources.integration.test.ts',
  'tools/integration-scenario.integration.test.ts',
  'tools/resource-catalog.integration.test.ts',
  'tools/t4-17-ext-n2.integration.test.ts',
  'tools/preset.integration.test.ts',
  'tools/t1-11.integration.test.ts',
  'tools/t4-03-cap6-central.integration.test.ts',
  // INT-19/AC-INT-19B: 여러 실제 차례를 진행하는 긴 장수 지시 시나리오. 권한 사례는 API 묶음의 별도 파일에 남긴다.
  'tools/int19-orders.integration.test.ts',
] as const;

export function integrationPartition(value: string | undefined): string[] {
  if (value === undefined || value === 'all') return [];
  if (value === 'engine') return [...ENGINE_INTEGRATION_FILES];
  if (value === 'api') return ENGINE_INTEGRATION_FILES.flatMap((file) => ['--exclude', file]);
  throw new Error('INTEGRATION_SUITE는 all·api·engine 중 하나여야 합니다.');
}
