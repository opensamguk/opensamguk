import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { rngFor } from '../packages/shared/src/index';
import {
  applySexLedger,
  buildInitialWorld,
  featureProfileSchema,
  initialReplayStateWithRegistry,
  resolverForRuleFeatures,
  ruleRegistry,
} from '../packages/rules/src/index';
import { applyEffects } from '../packages/rules/src/commands/effects';
import { crewContext, crewTypeFailure } from '../packages/rules/src/world/crewRequirements';
import { loadSexLedger } from '../apps/engine/src/world/resources';
import { expandedScenarioRow } from './expanded-resources';

const read = (path: string) => JSON.parse(readFileSync(new URL('../resources/' + path, import.meta.url), 'utf8'));
it('AC-P2-06 새22기능 판은 기존20기능 판을 보존하고 정식491명·45병종에서 연구를 연결한다', async () => {
  const old = read('feature-profile/expanded-191-v5.json');
  const source = read('feature-profile/expanded-191-v6.json');
  expect(source).toEqual({
    ...old,
    key: 'expanded-191-v6',
    ruleFeatures: [...old.ruleFeatures, 'prepared-turns-v1', 'nation-research-v1'].sort(),
  });
  const profile = featureProfileSchema.parse(source);
  expect(profile.ruleFeatures).toHaveLength(22);
  const initial = buildInitialWorld({
    seed: 'nation-research-public-profile',
    map: read('map/san10.json'),
    scenario: (await expandedScenarioRow()).content,
    unitSet: read('unitset/expanded.json'),
    statRules: read('scenario/five-stats.json'),
    portraitMap: read('portraits/191-map.json'),
  });
  initial.ruleFeatures = profile.ruleFeatures;
  initial.scenarioKey = profile.scenarioKey;
  initial.generals = applySexLedger(initial, loadSexLedger());
  let state = initialReplayStateWithRegistry(initial, ruleRegistry, {
    ...profile.featureData,
    policy: { version: 1, turnTermMinutes: 60 },
  }).state;
  expect(initial.generals).toHaveLength(491);
  expect(initial.unitSet.crewTypes).toHaveLength(45);
  expect(state.preparedTurns).toEqual({ version: 1, nations: {} });
  expect(state.nationResearch).toEqual({ version: 1, nations: {} });
  const resolver = resolverForRuleFeatures(state)!;
  expect(resolver.list('nation').filter((command) => command.key.startsWith('nation_research_'))).toHaveLength(7);
  const ruler = Object.values(state.generals).find(
    (general) =>
      general.officerLevel === 12 &&
      state.nations[general.nationId!]!.gold >= 50_000 &&
      state.nations[general.nationId!]!.rice >= 50_000,
  )!;
  const actor = {
    generalId: ruler.id,
    target: 'nation' as const,
    authority: 'office' as const,
    tick: 0,
    unitSet: initial.unitSet,
  };
  const researchUnit = initial.unitSet.crewTypes.find((crew) =>
    crew.requirements?.some((requirement) => requirement.kind === 'research' && requirement.name === 'greatsword'),
  )!;
  expect(crewContext(state, actor).research).toEqual([]);
  const beforeCrew = crewTypeFailure(researchUnit, crewContext(state, actor));
  expect(beforeCrew).not.toBeNull();
  for (let turn = 0; turn < 12; turn++) {
    const result = resolver.run(
      state,
      actor,
      'nation_research_greatsword',
      {},
      rngFor(initial.seed, 'research-profile', turn),
    );
    if ('code' in result) throw new Error(result.message);
    state = applyEffects(state, result.effects);
  }
  expect(crewContext(state, actor).research).toEqual(['greatsword']);
  // 연구가 끝나도 기존 기술·보유 도시 조건을 생략하지 않는다.
  expect(crewTypeFailure(researchUnit, crewContext(state, actor))).not.toBeNull();
  expect(state.nations[ruler.nationId!]!.tech).toBe(
    initial.nations.find((nation) => nation.id === ruler.nationId)!.tech,
  );
});
