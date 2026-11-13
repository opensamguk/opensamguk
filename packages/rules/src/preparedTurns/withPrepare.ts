import { applyEffects } from '../commands/effects';
import type { CommandDef, CommandResult, Failure } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldState } from '../model/world';
import { advancePrepare, readPreparedTurns } from './state';

function clearRecord(state: WorldState, nationId: number, officerLevel: number) {
  const entries = state.preparedTurns!.nations[nationId];
  if (!entries) return;
  delete entries[officerLevel];
  if (Object.keys(entries).length === 0) delete state.preparedTurns!.nations[nationId];
}

export function withPrepare(definition: CommandDef, spec: { preReqTurn: number }): CommandDef {
  if (definition.target !== 'nation') throw new Error('국가 명령만 준비할 수 있습니다.');
  // 등록할 때도 기간을 검사해 첫 실행까지 설정 오류를 미루지 않는다.
  advancePrepare(undefined, definition.key, {}, spec.preReqTurn);
  return {
    ...definition,
    execute(view, actor, args, rng) {
      const general = view.generals[actor.generalId];
      if (!general || general.nationId === null) throw new Error('준비할 국가가 없습니다.');
      const nationId = general.nationId,
        officerLevel = general.officerLevel;
      const ledger = readPreparedTurns(view.preparedTurns, view);
      if (!ledger) throw new Error('명령 준비 기능이 필요합니다.');
      const progress = advancePrepare(ledger.nations[nationId]?.[officerLevel], definition.key, args, spec.preReqTurn);
      if (progress.phase === 'prepare') {
        const state = cloneWorld(view);
        (state.preparedTurns!.nations[nationId] ??= {})[officerLevel] = progress.record;
        return {
          effects: [{ kind: 'world', state }],
          logs: [
            { kind: 'success', text: `${definition.name} 준비 중 (${progress.record.term}/${spec.preReqTurn + 1})` },
          ],
        };
      }
      const result = definition.execute(view, actor, args, rng);
      const state = applyEffects(view, result.effects);
      clearRecord(state, nationId, officerLevel);
      return { ...result, effects: [{ kind: 'world', state }] };
    },
  };
}

export function trackNationTurn(
  state: WorldState,
  actor: { nationId: number; officerLevel: number },
  commandKey: string,
  result: CommandResult | Failure,
): WorldState {
  const ledger = readPreparedTurns(state.preparedTurns, state);
  if (!ledger || 'code' in result) return state;
  const record = ledger.nations[actor.nationId]?.[actor.officerLevel];
  if (record && record.commandKey !== commandKey) clearRecord(state, actor.nationId, actor.officerLevel);
  return state;
}
