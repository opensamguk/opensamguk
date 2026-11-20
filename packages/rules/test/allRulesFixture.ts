import type { WorldInit } from '../src/world/bootstrap';
import { buildInitialWorld } from '../src/world/bootstrap';
import { operationalInput } from './operationalMapFixture';
export function allRulesInitial(): WorldInit {
  const initial = buildInitialWorld(operationalInput());
  initial.fogOfWar = false;
  initial.generals = initial.generals.map((general) => ({ ...general, sex: 'UNKNOWN' }));
  return initial;
}
