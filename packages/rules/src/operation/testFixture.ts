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
  Object.assign(view.generals[1]!, current, { userId: 'human' });
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
