import { checkReplayOrigin } from '../ruleRegistry';
import { readNationLifecycle } from './state';

export function readStoredNationLifecycle(world: {
  ruleFeatures: readonly string[];
  replayFormat: number;
  replayOrigin: unknown;
  nationLifecycleState: unknown;
}) {
  if (world.ruleFeatures.includes('nation-lifecycle-v1')) {
    const origin = world.replayOrigin;
    checkReplayOrigin(origin);
    if (
      world.replayFormat !== 3 ||
      origin.version !== 3 ||
      JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures)
    )
      throw new Error('국가 변천의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readNationLifecycle(world.nationLifecycleState, world);
}
