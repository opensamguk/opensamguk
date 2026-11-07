// core2026 df6c926의 eventResearch를 D-077과 현행 직책 예약에 맞췄다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { z } from 'zod';
import { fail, targetGeneral } from '../commands/support';
import type { Actor, CommandDef, Failure } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { withPrepare } from '../preparedTurns/withPrepare';
import { NATION_RESEARCH_FEATURE, readNationResearch, type ResearchName } from './state';

const specs = [
  { key: 'nation_research_greatsword', research: 'greatsword', name: '대검병 연구', turns: 12, cost: 50_000 },
  { key: 'nation_research_halberd', research: 'halberd', name: '극병 연구', turns: 24, cost: 100_000 },
  { key: 'nation_research_fire_arrow', research: 'fire_arrow', name: '화시병 연구', turns: 12, cost: 50_000 },
  { key: 'nation_research_repeater', research: 'repeater', name: '원융노병 연구', turns: 24, cost: 100_000 },
  { key: 'nation_research_mountain', research: 'mountain', name: '산저병 연구', turns: 12, cost: 50_000 },
  { key: 'nation_research_elephant', research: 'elephant', name: '상병 연구', turns: 24, cost: 100_000 },
  { key: 'nation_research_fire_wheel', research: 'fire_wheel', name: '화륜차 연구', turns: 24, cost: 100_000 },
] as const satisfies readonly { key: string; research: ResearchName; name: string; turns: number; cost: number }[];
const args = z.strictObject({});

export function canExecuteResearchNationCommand(view: Pick<WorldView, 'ruleFeatures'>, level: number, key: string) {
  return (
    !!view.ruleFeatures?.includes(NATION_RESEARCH_FEATURE) &&
    Number.isInteger(level) &&
    level >= 5 &&
    level <= 12 &&
    specs.some((spec) => spec.key === key)
  );
}

function defineResearch(spec: (typeof specs)[number]): CommandDef {
  const check = (view: WorldView, actor: Actor, raw: unknown): Failure | null => {
    const general = targetGeneral(view, actor.generalId);
    if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
    if (general.nationId === null || !view.nations[general.nationId])
      return fail('NOT_NATION', '국가에 소속되어야 합니다.');
    if (view.cities[general.cityKey]?.nationId !== general.nationId)
      return fail('NOT_OWN_CITY', '자기 국가 도시에서만 가능합니다.');
    if (!view.ruleFeatures?.includes(NATION_RESEARCH_FEATURE))
      return fail('COMMAND_DISABLED', '이 월드에서 꺼진 명령입니다.');
    if (!canExecuteResearchNationCommand(view, general.officerLevel, spec.key))
      return fail('NOT_RULER', '수뇌 이상만 연구할 수 있습니다.');
    if (!args.safeParse(raw).success) return fail('BAD_ARGS', '연구 명령의 인자를 확인하세요.');
    const ledger = readNationResearch(view.nationResearch, view)!;
    if (ledger.nations[general.nationId]?.includes(spec.research))
      return fail('BAD_STATE', `${spec.name}가 이미 완료되었습니다.`);
    const nation = view.nations[general.nationId]!;
    if (nation.gold < spec.cost) return fail('NO_GOLD', '국고 금이 부족합니다.');
    if (nation.rice < spec.cost) return fail('NO_RICE', '국고 쌀이 부족합니다.');
    return null;
  };
  return withPrepare(
    {
      key: spec.key,
      name: spec.name,
      category: 'nation',
      target: 'nation',
      args,
      precheck: check,
      check,
      execute(view, actor, raw) {
        const failure = check(view, actor, raw);
        if (failure) throw new Error(failure.message);
        const state = cloneWorld(view),
          general = state.generals[actor.generalId]!,
          nationId = general.nationId!;
        const nation = state.nations[nationId]!;
        nation.gold -= spec.cost;
        nation.rice -= spec.cost;
        general.experience += 5 * spec.turns;
        general.dedication += 5 * spec.turns;
        const ledger = readNationResearch(state.nationResearch, state)!;
        ledger.nations[nationId] = [...(ledger.nations[nationId] ?? []), spec.research].sort();
        state.nationResearch = ledger;
        const text = `${spec.name} 완료`;
        return {
          effects: [{ kind: 'world', state }],
          logs: [{ kind: 'success', text }],
          history: [{ nationId, text: `${general.name} ${text}` }],
        };
      },
    },
    { preReqTurn: spec.turns - 1 },
  );
}

export const nationResearchCommands: readonly CommandDef[] = specs.map(defineResearch);
