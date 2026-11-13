import { z } from 'zod';
import { changeTroop, troopActionSchema } from './actions';
import { readTroops } from './state';
import type { RecordedInput, ReplayState } from '../../../replay';

const resultSchema = z.strictObject({ changed: z.array(z.number().int().positive()) });

export function applyTroopInput(replay: ReplayState, input: RecordedInput): ReplayState {
  const before = readTroops(replay.state);
  const actor = input.generalId === null ? undefined : replay.state.generals[input.generalId];
  if (!before || !actor || actor.userId === null) throw new Error('부대 변경 기록의 장수를 확인하세요.');
  const outcome = changeTroop(replay.state, before, actor.id, troopActionSchema.parse(input.payload));
  const { changed } = resultSchema.parse(input.result);
  if (
    !outcome.ok ||
    changed.length !== outcome.changed.length ||
    changed.some((id, index) => id !== outcome.changed[index])
  )
    throw new Error('부대 변경 기록의 결과를 확인하세요.');
  return { ...replay, state: { ...replay.state, ext: { ...replay.state.ext, troop: outcome.slice } } };
}
