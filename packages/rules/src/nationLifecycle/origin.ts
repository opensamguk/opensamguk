import { checkedReplayOrigin } from '../ruleRegistry';
import { readNationLifecycle } from './state';

export function readStoredNationLifecycle(
  world: {
    replayFormat: number;
    replayOrigin: unknown;
    nationLifecycleState: unknown;
  },
  checkedOrigin?: ReturnType<typeof checkedReplayOrigin>,
) {
  {
    const origin = checkedReplayOrigin(world.replayOrigin, checkedOrigin);
    if (world.replayFormat !== 3 || origin.version !== 3 || false)
      throw new Error('국가 변천의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readNationLifecycle(world.nationLifecycleState);
}
