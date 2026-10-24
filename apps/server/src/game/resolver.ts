import {
  parsePreset,
  presetCommands,
  resolverForPreset,
  resolverForRuleFeatures,
  selectWorldCapabilities,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';

type ResolverWorld = {
  preset: unknown;
  replayOrigin?: unknown;
  replayFormat?: number;
  ruleFeatures?: readonly string[];
} & Partial<Parameters<typeof selectWorldCapabilities>[0]>;

export function worldResolver(world: ResolverWorld) {
  const preset = world.preset ? parsePreset(world.preset) : null;
  const commands = presetCommands(preset);
  const origin = world.replayOrigin;
  const hasExt =
    origin !== null &&
    typeof origin === 'object' &&
    'capabilities' in origin &&
    origin.capabilities !== null &&
    typeof origin.capabilities === 'object' &&
    Object.hasOwn(origin.capabilities, 'ext');
  if (commands !== null) {
    if (!hasExt) throw new Error('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
    const selected = selectWorldCapabilities(world as Parameters<typeof selectWorldCapabilities>[0]);
    if (
      selected.kind !== 'caps' ||
      !('ext' in selected.selection) ||
      hashState(preset) !== hashState(selected.selection.ext.preset)
    )
      throw new Error('확장 명령과 생성 기록이 다릅니다.');
  } else if (hasExt) throw new Error('확장 명령과 생성 기록이 다릅니다.');
  return {
    preset,
    commands,
    resolver:
      (world.replayFormat === 3
        ? resolverForRuleFeatures(world.ruleFeatures ? { ruleFeatures: world.ruleFeatures } : {})
        : undefined) ?? resolverForPreset(preset),
  };
}
