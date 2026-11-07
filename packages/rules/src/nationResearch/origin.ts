import { checkReplayOrigin } from '../ruleRegistry';
import { NATION_RESEARCH_FEATURE, readNationResearch } from './state';

export function readStoredNationResearch(world: {
  ruleFeatures: readonly string[];
  replayFormat: number;
  replayOrigin: unknown;
  nationResearchState: unknown;
}) {
  if (world.ruleFeatures.includes(NATION_RESEARCH_FEATURE)) {
    const origin = world.replayOrigin;
    checkReplayOrigin(origin);
    if (
      world.replayFormat !== 3 ||
      origin.version !== 3 ||
      JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures)
    )
      throw new Error('병종 연구의 재생 형식이나 생성 원장이 다릅니다.');
  }
  return readNationResearch(world.nationResearchState, world);
}
