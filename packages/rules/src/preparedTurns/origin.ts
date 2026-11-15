import { checkReplayOrigin } from '../ruleRegistry';
import { readPreparedTurns } from './state';

export function readStoredPreparedTurns(world: {
  replayFormat: number;
  replayOrigin: unknown;
  preparedTurnsState: unknown;
}) {
  {
    const origin = world.replayOrigin;
    checkReplayOrigin(origin);
    if (world.replayFormat !== 3 || origin.version !== 3 || false)
      throw new Error('명령 준비의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readPreparedTurns(world.preparedTurnsState);
}
