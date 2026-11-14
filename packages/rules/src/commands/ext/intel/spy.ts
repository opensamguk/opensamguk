import { commandLog } from '../../support';
import { cityPart, textPart, actPart, logSentence } from '../../logging';
import { cloneWorld } from '../../../model/clone';
import type { WorldState, WorldView } from '../../../model/world';
import type { CommandDef } from '../../types';
import { buildIntelRecord, checkSpy, INTEL, spyArgs } from './base';
import type { IntelSliceValue } from './record';

export function makeSpyCommand(clone: (view: WorldView) => WorldState = cloneWorld): CommandDef {
  return {
    key: 'spy',
    name: '첩보',
    category: 'military',
    target: 'general',
    args: spyArgs,
    precheck: checkSpy,
    check: checkSpy,
    execute(view, actor, raw, rng) {
      const failure = checkSpy(view, actor, raw);
      if (failure) throw new Error(failure.message);
      const { cityKey } = spyArgs.parse(raw);
      const state = clone(view);
      if (!state.ext?.intel) throw new Error('첩보 상태 조각이 없습니다: intel');
      const intel = state.ext.intel as IntelSliceValue;
      const general = state.generals[actor.generalId]!;
      const record = buildIntelRecord(view, actor, cityKey);
      general.gold -= INTEL.COST_GOLD;
      general.rice -= INTEL.COST_RICE;
      general.experience += rng.int(1, 100);
      general.dedication += rng.int(1, 70);
      for (const nationId of Object.keys(intel)) if (!state.nations[Number(nationId)]) delete intel[nationId];
      (intel[String(general.nationId)] ??= {})[String(cityKey)] = record;
      const city = state.cities[cityKey]!;
      const message =
        record.level === 1
          ? ' 정보를 많이 얻었습니다'
          : record.level === 2
            ? ' 정보를 어느 정도 얻었습니다'
            : ' 소문만 들었습니다';
      return {
        effects: [{ kind: 'world', state }],
        logs: [commandLog([actPart('spy', '첩보'), textPart(': '), cityPart(city), textPart(message)])],
        ...(city.nationId === null
          ? {}
          : {
              history: [
                {
                  nationId: city.nationId,
                  kind: 'intel',
                  ...logSentence([cityPart(city), textPart(': 누군가 이 도시를 살폈습니다')]),
                },
              ],
            }),
      };
    },
  };
}

export const spy = makeSpyCommand();
