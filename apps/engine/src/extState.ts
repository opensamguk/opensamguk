import { readWorldExtRows, writeWorldExtChanges, type Prisma } from '@opensamguk/db';
import {
  parsePreset,
  presetCommands,
  resolverForPreset,
  resolverForRuleFeatures,
  restoreExtState,
  selectWorldCapabilities,
  type EnabledCommands,
  type WorldState,
} from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';

type ResolverWorld = {
  preset: unknown;
  replayOrigin?: unknown;
  replayFormat?: number;
  ruleFeatures?: readonly string[];
} & Partial<Parameters<typeof selectWorldCapabilities>[0]>;

export function engineResolver(world: ResolverWorld) {
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
    // 저장 행의 필수 칸은 선택자가 검사한다. 생성 전의 preset만으로는 켤 수 없다.
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

export async function loadExt(tx: Prisma.TransactionClient, worldId: string, commands: EnabledCommands | null) {
  // 호출자는 engineResolver로 저장된 선택과 프리셋을 먼저 대조한다.
  return restoreExtState(commands, await readWorldExtRows(tx, worldId));
}

export async function persistExt(
  tx: Prisma.TransactionClient,
  worldId: string,
  before: WorldState['ext'],
  next: WorldState['ext'],
) {
  await writeWorldExtChanges(tx, worldId, before, next);
}

export async function verifyWorldExt(tx: Prisma.TransactionClient, world: ResolverWorld & { id: string }) {
  const { commands } = engineResolver(world);
  await loadExt(tx, world.id, commands);
}
