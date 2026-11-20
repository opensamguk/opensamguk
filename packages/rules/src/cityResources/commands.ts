import { z } from 'zod';
import { applyEffects } from '../commands/effects';
import type { CommandResolver } from '../commands/resolve';
import type { Actor, CommandDef, CommandResult } from '../commands/types';
import { fail, success } from '../commands/support';
import { checkCampaignActor } from '../campaign/commands';
import type { WorldView } from '../model/world';
import { applyCityAllocation, cityAllocationArgs } from './allocation';
import { applyCityPreparation, applyCityUnitRecruitment, cityDrillArgs, cityRecruitArgs } from './preparation';
import { disbandCityGarrison } from './ownership';
import { readCityResourcesState } from './state';
import { campaignRecruitArgs } from '../campaign/preparation';

export function canExecuteCityNationCommand(view: object, level: number, key: string): boolean {
  return key === 'nation_city_allocate' && [5, 6, 7, 8, 9, 10, 11, 12].includes(level);
}

export function createCityResourceCommandResolver(base: CommandResolver): CommandResolver {
  function definition(key: string): CommandDef | undefined {
    const original = base.get(key);
    const cityPreparation = key === 'recruit' || key === 'conscript' || key === 'train' || key === 'morale';
    if (!original && key !== 'nation_city_allocate') return undefined;
    const custom = key === 'nation_city_allocate';
    const args =
      key === 'nation_city_allocate'
        ? cityAllocationArgs
        : key === 'recruit' || key === 'conscript'
          ? z.union([cityRecruitArgs, campaignRecruitArgs])
          : key === 'train' || key === 'morale'
            ? z.union([cityDrillArgs, original!.args])
            : original!.args;
    const cityAction = (view: WorldView, actor: Actor, value: unknown) => {
      if (key === 'nation_city_allocate') return applyCityAllocation(view, actor, value);
      if ((key === 'recruit' || key === 'conscript') && value && typeof value === 'object' && 'unitId' in value) {
        const denied = checkCampaignActor(view, actor, key, value);
        return denied ? { ok: false as const, ...denied } : applyCityUnitRecruitment(view, actor, key, value);
      }
      if (
        key === 'recruit' ||
        key === 'conscript' ||
        ((key === 'train' || key === 'morale') && value && typeof value === 'object' && 'target' in value)
      ) {
        const denial = checkCampaignActor(view, actor, key, value);
        return denial
          ? { ok: false as const, ...denial }
          : applyCityPreparation(view, actor, key as 'recruit' | 'conscript' | 'train' | 'morale', value);
      }
      return null;
    };
    const check = (view: WorldView, actor: Actor, value: unknown) => {
      const outcome = cityAction(view, actor, value);
      return outcome ? (outcome.ok ? null : fail(outcome.code, outcome.message)) : original!.check(view, actor, value);
    };
    return {
      ...(original ?? {
        key,
        name: '도시 병력 배속',
        category: 'nation',
        target: 'nation',
      }),
      args,
      check,
      precheck: check,
      execute(view, actor, value, rng): CommandResult {
        const failure = check(view, actor, value);
        if (failure) throw new Error(failure.message);
        const outcome = custom || cityPreparation ? cityAction(view, actor, value) : null;
        if (outcome && !outcome.ok) throw new Error(outcome.message);
        const result =
          outcome && outcome.ok
            ? { ...success(outcome.text), effects: [{ kind: 'world' as const, state: outcome.state }] }
            : original!.execute(view, actor, value, rng);
        let state = applyEffects(view, result.effects);
        const logs = [...result.logs];
        for (const before of Object.values(view.cities)) {
          if (state.cities[before.cityKey]?.nationId === before.nationId) continue;
          const ended = disbandCityGarrison(state, before.cityKey);
          state = ended.state;
          if (ended.troops) logs.push({ kind: 'success', text: ended.text });
        }
        readCityResourcesState(
          state.cityResources,
          state,
          actor.unitSet?.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
        );
        return { ...result, logs, effects: [{ kind: 'world', state }] };
      },
    } as CommandDef;
  }
  function prepare(actor: Actor, key: string, value: unknown) {
    const def = definition(key);
    if (!def) return { failure: fail('UNKNOWN_COMMAND', '없는 명령입니다.') };
    if (def.target !== (actor.target ?? 'general')) return { failure: fail('BAD_ARGS', '명령 대상이 다릅니다.') };
    const parsed = def.args.safeParse(value);
    return parsed.success ? { def, args: parsed.data } : { failure: fail('BAD_ARGS', '명령 인자가 잘못되었습니다.') };
  }
  return {
    get: definition,
    list: (target) => [
      ...base.list(target).map((def) => definition(def.key)!),
      ...(target === 'nation' ? [definition('nation_city_allocate')!] : []),
    ],
    precheck(view, actor, key, value) {
      const parsed = prepare(actor, key, value);
      return parsed.failure ?? parsed.def!.precheck(view, actor, parsed.args);
    },
    run(view, actor, key, value, rng) {
      const parsed = prepare(actor, key, value);
      return (
        parsed.failure ??
        parsed.def!.check(view, actor, parsed.args) ??
        parsed.def!.execute(view, actor, parsed.args, rng)
      );
    },
  };
}
