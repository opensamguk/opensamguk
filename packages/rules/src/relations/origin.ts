import { checkedReplayOrigin, replayResourceHashInput } from '../ruleRegistry';
import { readRelationsData, RELATIONS_FEATURE } from './data';

export function readStoredRelations(
  world: {
    replayFormat: number;

    replayOrigin: unknown;
    initialStateHash: string;
  },
  hash: (value: unknown) => string,
  checkedOrigin?: ReturnType<typeof checkedReplayOrigin>,
) {
  const origin = checkedReplayOrigin(world.replayOrigin, checkedOrigin);
  if (
    world.replayFormat !== 3 ||
    origin.version !== 3 ||
    origin.initialStateHash !== world.initialStateHash ||
    origin.initialStateHash !== hash(origin.initial) ||
    origin.resourceHash !== hash(replayResourceHashInput(origin.initial, origin.featureData))
  )
    throw new Error('관계 자료의 생성 기록과 해시가 다릅니다.');
  return readRelationsData(origin.initial, origin.featureData?.[RELATIONS_FEATURE]);
}
