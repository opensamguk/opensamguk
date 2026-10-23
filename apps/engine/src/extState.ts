import { readWorldExtRows, writeWorldExtChanges, type Prisma } from '@opensamguk/db';
import {
  parsePreset,
  presetCommands,
  resolverForPreset,
  restoreExtState,
  type EnabledCommands,
  type WorldState,
} from '@opensamguk/rules';

export function engineResolver(world: { preset: unknown }) {
  const preset = world.preset ? parsePreset(world.preset) : null;
  const commands = presetCommands(preset);
  if (commands !== null) throw new Error('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
  return { preset, commands, resolver: resolverForPreset(preset) };
}

export async function loadExt(tx: Prisma.TransactionClient, worldId: string, commands: EnabledCommands | null) {
  if (commands !== null) throw new Error('확장 명령을 켠 월드는 아직 지원하지 않습니다.');
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

export async function verifyWorldExt(tx: Prisma.TransactionClient, world: { id: string; preset: unknown }) {
  const { commands } = engineResolver(world);
  await loadExt(tx, world.id, commands);
}
