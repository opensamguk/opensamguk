import { checkReplayOrigin } from '../ruleRegistry';
import { PREPARED_TURNS_FEATURE, readPreparedTurns } from './state';

export function readStoredPreparedTurns(world: {
  ruleFeatures: readonly string[];
  replayFormat: number;
  replayOrigin: unknown;
  preparedTurnsState: unknown;
}) {
  if (world.ruleFeatures.includes(PREPARED_TURNS_FEATURE)) {
    const origin = world.replayOrigin;
    checkReplayOrigin(origin);
    if (
      world.replayFormat !== 3 ||
      origin.version !== 3 ||
      JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures)
    )
      throw new Error('명령 준비의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readPreparedTurns(world.preparedTurnsState, world);
}
