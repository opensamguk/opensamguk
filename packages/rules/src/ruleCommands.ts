import { createCommandResolverWithCommands, extensionCommands, type CommandResolver } from './commands/resolve';
import { ruleRegistry, type RuleRegistry } from './ruleRegistry';
import { createCampaignCommandResolver } from './campaign/commands';
import { createCityResourceCommandResolver } from './cityResources/commands';
import { createGovernanceCommandResolver } from './governance/commands';
import { createStratagemCardResolver } from './stratagemCards/resolver';
import { createNationLifecycleResolver } from './nationLifecycle/resolver';
import { extRegistryForRuleFeatures } from './commands/ext/state';
import { battleCommandBusy } from './tactical/world';

// 등록된 모든 규칙의 명령을 제공한다.
export function resolverForRuleFeatures(
  state: object,
  registry: RuleRegistry = ruleRegistry,
): CommandResolver | undefined {
  const bindings = registry.features.flatMap((feature) => feature.commandBindings ?? []);
  const { slices } = extRegistryForRuleFeatures();
  if (bindings.some((binding) => binding.sliceKeys.some((key) => !slices.some((slice) => slice.key === key))))
    throw new Error('이 규칙 명령은 저장 조각을 지원하지 않습니다.');
  const definitions = bindings.map((binding) => binding.definition);
  const enabled = {
    general: definitions.filter((definition) => definition.target === 'general').map((definition) => definition.key),
    nation: definitions.filter((definition) => definition.target === 'nation').map((definition) => definition.key),
  };
  const resolver = createCommandResolverWithCommands(enabled, [
    ...extensionCommands.filter((definition) => !definitions.includes(definition)),
    ...definitions,
  ]);
  const lifecycle = createNationLifecycleResolver(resolver);
  const selected = createCampaignCommandResolver(lifecycle);
  const resources = createCityResourceCommandResolver(selected);
  const cards = createStratagemCardResolver(resources);
  const final = createGovernanceCommandResolver(cards);
  return {
    ...final,
    precheck(view, actor, key, args) {
      return battleCommandBusy(view, actor.generalId, key, args)
        ? { code: 'BATTLE_BUSY', message: '전투 중' }
        : final.precheck(view, actor, key, args);
    },
    run(view, actor, key, args, rng) {
      return battleCommandBusy(view, actor.generalId, key, args)
        ? { code: 'BATTLE_BUSY', message: '전투 중' }
        : final.run(view, actor, key, args, rng);
    },
  };
}
