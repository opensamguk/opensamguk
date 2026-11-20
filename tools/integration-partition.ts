import { isAbsolute } from 'node:path';

export const AUTHZ_SHARD_TOTAL = 3;
export const ENGINE_SHARD_TOTAL = 4;

export function integrationShardArgs(suite: string | undefined, shard: string | undefined, report: string | undefined) {
  if (shard === undefined && report === undefined) return [];
  // engine-long은 파일 하나짜리 별도 job이라 나누지 않는다.
  if (suite !== 'api' && suite !== 'engine') throw new Error('integration shard suite');
  if (!shard || !report || !isAbsolute(report) || !/^[1-9]\d*\/[1-9]\d*$/.test(shard))
    throw new Error('integration shard-spec');
  const [index, total] = shard.split('/').map(Number);
  const expectedTotal = suite === 'api' ? AUTHZ_SHARD_TOTAL : ENGINE_SHARD_TOTAL;
  if (total !== expectedTotal || index! > total) throw new Error('integration shard-spec');
  return [`--shard=${shard}`, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`];
}

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
  'tools/battle-sim-resources.integration.test.ts',
  'tools/commands.integration.test.ts',
  'tools/world-bootstrap.integration.test.ts',
  'tools/resource-editor-validate.integration.test.ts',
  'tools/resource-validate.integration.test.ts',
  'tools/world-presets.integration.test.ts',
  'tools/load-profile.integration.test.ts',
  'tools/operational-map.integration.test.ts',
  'tools/integration-scenario-build.integration.test.ts',
  'tools/san10-build.integration.test.ts',
  'tools/officer-ledger.integration.test.ts',
  'tools/int19-retinue-orders.integration.test.ts',
  'tools/city-scale-resources.integration.test.ts',
  'tools/create-options-resources.integration.test.ts',
  'tools/campaign-source.integration.test.ts',
  'tools/feature-profile.integration.test.ts',
  'tools/resource-versions.integration.test.ts',
  'tools/portrait-map-convert.integration.test.ts',
  'tools/officer-sex-ledger.integration.test.ts',
  'tools/create-request-resources.integration.test.ts',
  'tools/reset-preparation-resources.integration.test.ts',
  'tools/world-reset-resource.integration.test.ts',
  'tools/t4-17-ext-n2.integration.test.ts',
  'tools/preset.integration.test.ts',
  'tools/t1-11.integration.test.ts',
  'tools/t4-03-cap6-central.integration.test.ts',
  // INT-19/AC-INT-19B: 여러 실제 차례를 진행하는 긴 장수 지시 시나리오. 권한 사례는 API 묶음의 별도 파일에 남긴다.
  'tools/int19-orders.integration.test.ts',
  // AC-P2-30·31·32·33: 정식 명단 확장 결합은 권한 기록 없이 엔진·저장·재생을 검사한다.
  'tools/expanded-native.integration.test.ts',
  'tools/int22-expanded-units.integration.test.ts',
] as const;

// 엔진 묶음 가운데 한 파일이 30분을 넘는 시험. 나눌 수 없으므로 자기 job(engine-long)에서 따로 돈다.
// AC-INT-22는 정식 12개월 재적재와 재생을 요구한다(로컬 33분).
export const ENGINE_LONG_INTEGRATION_FILES = ['tools/int22-expanded-units.integration.test.ts'] as const;
const long = new Set<string>(ENGINE_LONG_INTEGRATION_FILES);

export function integrationPartition(value: string | undefined): string[] {
  if (value === undefined || value === 'all') return [];
  if (value === 'engine') return ENGINE_INTEGRATION_FILES.filter((file) => !long.has(file));
  if (value === 'engine-long') return [...ENGINE_LONG_INTEGRATION_FILES];
  if (value === 'api') return ENGINE_INTEGRATION_FILES.flatMap((file) => ['--exclude', file]);
  throw new Error('INTEGRATION_SUITE는 all, api, engine, engine-long 중 하나여야 합니다.');
}
