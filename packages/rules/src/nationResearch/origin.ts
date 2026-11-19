import { checkedReplayOrigin } from '../ruleRegistry';
import { readNationResearch } from './state';

export function readStoredNationResearch(
  world: {
    replayFormat: number;
    replayOrigin: unknown;
    nationResearchState: unknown;
  },
  checkedOrigin?: ReturnType<typeof checkedReplayOrigin>,
) {
  {
    const origin = checkedReplayOrigin(world.replayOrigin, checkedOrigin);
    if (world.replayFormat !== 3 || origin.version !== 3 || false)
      throw new Error('병종 연구의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readNationResearch(world.nationResearchState);
}
