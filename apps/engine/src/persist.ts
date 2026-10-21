import type { Prisma } from '@opensamguk/db';
import type { Effect, WorldState } from '@opensamguk/rules';
import { persistCommandState } from './commandPersistence';

export async function persistEffects(
  tx: Prisma.TransactionClient,
  worldId: string,
  state: WorldState,
  effects: readonly Effect[],
) {
  // 규칙에서 보정한 최종값만 저장한다. 같은 필드의 효과가 여럿이어도 한 번 쓴다.
  if (effects.some((effect) => effect.kind === 'world')) {
    await persistCommandState(tx, worldId, state);
    return;
  }
  const changes = new Map<string, Exclude<Effect, { kind: 'world' }>>();
  for (const effect of effects) {
    if (effect.kind !== 'world') changes.set(`${effect.kind}:${effect.id}:${effect.field}`, effect);
  }
  for (const effect of changes.values()) {
    if (effect.kind === 'city') {
      await tx.city.update({
        where: { worldId_cityKey: { worldId, cityKey: effect.id } },
        data: { [effect.field]: state.cities[effect.id]![effect.field] },
      });
    } else if (effect.kind === 'nation') {
      await tx.nation.update({
        where: { worldId_id: { worldId, id: effect.id } },
        data: { [effect.field]: state.nations[effect.id]![effect.field] },
      });
    } else {
      await tx.general.update({
        where: { worldId_id: { worldId, id: effect.id } },
        data: { [effect.field]: state.generals[effect.id]![effect.field] },
      });
    }
  }
}

export async function shiftTurns(tx: Prisma.TransactionClient, worldId: string, generalId: number) {
  const slots = await tx.generalTurn.findMany({ where: { worldId, generalId }, orderBy: { slot: 'asc' } });
  await tx.generalTurn.deleteMany({ where: { worldId, generalId } });
  await tx.generalTurn.createMany({
    data: Array.from({ length: 30 }, (_, slot) => {
      const previous = slots.find((entry) => entry.slot === slot + 1);
      return {
        worldId,
        generalId,
        slot,
        commandKey: previous?.commandKey ?? 'rest',
        args: (previous?.args ?? {}) as Prisma.InputJsonValue,
      };
    }),
  });
}
