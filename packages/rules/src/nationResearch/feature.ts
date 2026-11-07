import type { RuleFeatureDefinition } from '../ruleRegistry';
import { PREPARED_TURNS_FEATURE } from '../preparedTurns/state';
import { nationResearchCommands } from './commands';
import { initialNationResearch, NATION_RESEARCH_FEATURE } from './state';

export const nationResearchFeature: RuleFeatureDefinition = {
  key: NATION_RESEARCH_FEATURE,
  requires: ['personnel', PREPARED_TURNS_FEATURE],
  conflicts: [],
  commandBindings: nationResearchCommands.map((definition) => ({ definition, sliceKeys: [] })),
  checkOrigin({ initial, data }) {
    if (Object.hasOwn(initial, 'nationResearch') || data !== undefined)
      throw new Error('병종 연구는 빈 완료 기록에서 시작합니다.');
    if (
      !initial.unitSet.crewTypes.some((crew) =>
        crew.requirements?.some((requirement) => requirement.kind === 'research'),
      )
    )
      throw new Error('연구 조건이 있는 병종 판이 필요합니다.');
  },
  initReplayState(replay) {
    if (Object.hasOwn(replay.state, 'nationResearch')) throw new Error('병종 연구 초기화가 중복됐습니다.');
    return { ...replay, state: { ...replay.state, nationResearch: initialNationResearch() } };
  },
};
