import type { PrismaClient } from '@opensamguk/db';
import { adminResetResourcesSchema, type WorldInit } from '@opensamguk/rules';
import type { InitialResources } from '../world/resources';
import { prepareInitialWorld, savePreparedInitialWorld, type InitialWorldOptions } from '../world/persistence';

export async function createWorldFromCli(
  db: PrismaClient,
  state: WorldInit,
  options: InitialWorldOptions,
  resources?: InitialResources,
) {
  const prepared = prepareInitialWorld(state, options);
  const refs = resources
    ? adminResetResourcesSchema.parse(
        Object.values(resources)
          .map(({ kind, name, version, contentHash }) => ({ kind, name, version, contentHash }))
          .sort((a, b) => a.kind.localeCompare(b.kind)),
      )
    : undefined;
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
          payload: { stateHash: result.stateHash, ...(refs ? { resources: refs } : {}) },
        },
      });
      return result;
    },
    { timeout: 30_000 },
  );
}
