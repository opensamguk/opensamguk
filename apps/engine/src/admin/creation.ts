import type { PrismaClient } from '@opensamguk/db';
import type { WorldInit } from '@opensamguk/rules';
import { prepareInitialWorld, savePreparedInitialWorld, type InitialWorldOptions } from '../world/persistence';

export async function createWorldFromCli(db: PrismaClient, state: WorldInit, options: InitialWorldOptions) {
  const prepared = prepareInitialWorld(state, options);
  return db.$transaction(
    async (tx) => {
      const result = await savePreparedInitialWorld(tx, prepared);
      await tx.auditLog.create({
        data: {
          actorKind: 'CLI',
          action: 'world.create.applied',
          targetType: 'World',
          targetId: result.worldId,
          worldId: result.worldId,
          payload: { stateHash: result.stateHash },
        },
      });
      return result;
    },
    { timeout: 30_000 },
  );
}
