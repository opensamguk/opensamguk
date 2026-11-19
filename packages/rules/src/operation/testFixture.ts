import { commandWorld, testUnits } from '../../test/commandFixture';
import { emptyQueue, type PolicySlot } from '../policy';
import type { OperationSuggestionInput } from './suggest';

export const directTurn = (commandKey: string, args: unknown = {}): PolicySlot => ({
  commandKey,
  args,
  explicit: true,
});
export function operationInput(overrides: Partial<OperationSuggestionInput> = {}): OperationSuggestionInput {
  const view = commandWorld();
  const current = overrides.current ?? { crew: 100, train: 100, atmos: 100 };
  Object.assign(view.generals[1]!, { userId: 'human' });
  Object.assign(view.campaign!.units[0]!, { troops: current.crew, train: current.train, atmos: current.atmos });
  if (current.crew === 0) view.campaign!.units = view.campaign!.units.filter((unit) => unit.ownerId !== 1);
  return {
    startYear: 191,
    nextTurnTick: 0,
    deadlineTick: 110000,
    targetCityKey: 2,
    current,
    min: { crew: 100, train: 100, atmos: 100 },
    turns: emptyQueue(),
    view,
    generalId: 1,
    policy: 'none',
    policyMode: true,
    crewType: 1100,
    actor: { generalId: 1, tick: 0, unitSet: testUnits },
    ...overrides,
  };
}
