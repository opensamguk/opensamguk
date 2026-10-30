import { createCommandResolverWithCommands, extensionCommands, type CommandResolver } from './commands/resolve';
import type { WorldView } from './model/world';
import { checkRuleFeatures, ruleRegistry, type RuleRegistry } from './ruleRegistry';
import { createCampaignCommandResolver } from './campaign/commands';
import { createCityResourceCommandResolver } from './cityResources/commands';

// 형식 3의 같은 기능 등록표에서 무상태 명령을 고른다. 기존 preset 선택은 따로 보존한다.
export function resolverForRuleFeatures(
  state: Pick<WorldView, 'ruleFeatures'>,
  registry: RuleRegistry = ruleRegistry,
): CommandResolver | undefined {
  if (!state.ruleFeatures?.length) return undefined;
  const features = checkRuleFeatures(state.ruleFeatures, registry);
  const bindings = registry.features
    .filter((feature) => features.includes(feature.key))
    .flatMap((feature) => feature.commandBindings ?? []);
  const campaign = features.includes('campaign-v1');
  if (!bindings.length && !campaign) return undefined;
  if (bindings.some((binding) => binding.sliceKeys.length))
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
  const selected = campaign ? createCampaignCommandResolver(resolver) : resolver;
  return features.includes('city-resources-v1') ? createCityResourceCommandResolver(selected) : selected;
}
