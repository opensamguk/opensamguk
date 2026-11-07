import { checkReplayOrigin, replayResourceHashInput } from '../ruleRegistry';
import { readRelationsData, RELATIONS_FEATURE } from './data';

export function readStoredRelations(
  world: { replayFormat: number; ruleFeatures: readonly string[]; replayOrigin: unknown },
  hash: (value: unknown) => string,
) {
  if (!world.ruleFeatures.includes(RELATIONS_FEATURE)) return undefined;
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin);
  if (
    world.replayFormat !== 3 ||
    origin.version !== 3 ||
    !origin.initial.ruleFeatures?.includes(RELATIONS_FEATURE) ||
    origin.resourceHash !== hash(replayResourceHashInput(origin.initial, origin.featureData))
  )
    throw new Error('관계 자료의 생성 기록과 해시가 다릅니다.');
  return readRelationsData(origin.initial, origin.featureData?.[RELATIONS_FEATURE]);
}
