import type { ReplayOriginV3 } from '../ruleRegistry';

export function checkOriginHashes(origin: ReplayOriginV3, hash: (value: unknown) => string): void {
  const initial = origin.initial;
  const resources = {
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    ...(initial.operationalMap ? { operationalMap: initial.operationalMap } : {}),
    ...(origin.featureData ? { featureData: origin.featureData } : {}),
  };
  if (origin.initialStateHash !== hash(initial) || origin.resourceHash !== hash(resources))
    throw new Error('원생성 상태·자원 해시가 다릅니다.');
}
