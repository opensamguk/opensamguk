import { parsePreset, presetCommands, resolverForPreset } from '@opensamguk/rules';

export function worldResolver(world: { preset: unknown }) {
  const preset = world.preset ? parsePreset(world.preset) : null;
  const commands = presetCommands(preset);
  if (commands !== null) throw new Error('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
  return { preset, commands, resolver: resolverForPreset(preset) };
}
