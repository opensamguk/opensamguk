import { checkReplayOrigin } from '../ruleRegistry';
import { readNationStrategy } from './state';

export function readStoredNationStrategy(world: {
  replayFormat: number;
  replayOrigin: unknown;
  nationStrategyState: unknown;
}) {
  {
    const origin = world.replayOrigin;
    checkReplayOrigin(origin);
    if (world.replayFormat !== 3 || origin.version !== 3 || false)
      throw new Error('전략 대기의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readNationStrategy(world.nationStrategyState);
}
