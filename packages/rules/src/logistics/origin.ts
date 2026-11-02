import { readLogisticsConfig } from './state';
import type { WorldView } from '../model/world';

export function readLogisticsOriginConfig(
  world: { replayFormat: number; ruleFeatures: readonly string[]; replayOrigin: unknown },
  state: Pick<WorldView, 'cities'>,
) {
  if (!world.ruleFeatures.includes('logistics-v1')) return undefined;
  const origin = world.replayOrigin;
  if (
    world.replayFormat !== 3 ||
    !origin ||
    typeof origin !== 'object' ||
    Array.isArray(origin) ||
    !('featureData' in origin) ||
    !origin.featureData ||
    typeof origin.featureData !== 'object' ||
    Array.isArray(origin.featureData)
  )
    throw new Error('물류의 원생성 설정이 없습니다.');
  return readLogisticsConfig(
    'logistics-v1' in origin.featureData ? origin.featureData['logistics-v1'] : undefined,
    state,
  );
}
