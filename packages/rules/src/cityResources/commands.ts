import { z } from 'zod';
import { applyEffects } from '../commands/effects';
import type { CommandResolver } from '../commands/resolve';
import type { Actor, CommandDef, CommandResult } from '../commands/types';
import { fail, ownCity, success } from '../commands/support';
import { checkCampaignActor } from '../campaign/commands';
import { readCampaignState } from '../campaign/state';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { applyCityAllocation, cityAllocationArgs } from './allocation';
import { applyCityPreparation, cityDrillArgs, cityRecruitArgs } from './preparation';
import { disbandCityGarrison } from './ownership';
import { readCityResourcesState } from './state';

const formArgs = z.strictObject({ crewType: z.number().int().min(1).max(2_147_483_647) });
export function canExecuteCityNationCommand(
  view: Pick<WorldView, 'ruleFeatures'>,
  level: number,
  key: string,
): boolean {
  return (
    !!view.ruleFeatures?.includes('city-resources-v1') &&
    key === 'nation_city_allocate' &&
    [5, 6, 7, 8, 9, 10, 11, 12].includes(level)
  );
}

function formUnit(view: WorldView, actor: Actor, value: unknown) {
  const denied = ownCity(view, actor) ?? checkCampaignActor(view, actor, 'recruit');
  if (denied) return { ok: false as const, ...denied };
  const args = formArgs.safeParse(value);
  if (!args.success) return { ok: false as const, ...fail('BAD_ARGS', '빈 부곡의 병종을 확인하세요.') };
  if (!actor.unitSet?.crewTypes.some((row) => row.id === args.data.crewType && row.armType > 0))
    return { ok: false as const, ...fail('NO_UNIT_SET', '편성할 병종을 확인하세요.') };
  const campaign = readCampaignState(view.campaign, view);
  if (
    campaign.units.some(
      (row) => row.ownerId === actor.generalId && row.troops === 0 && row.crewType === args.data.crewType,
    )
  )
    return { ok: false as const, ...fail('BAD_STATE', '같은 병종의 빈 부곡이 이미 있습니다.') };
  if (campaign.nextUnitId === 2_147_483_647 || campaign.revision === 2_147_483_647)
    return { ok: false as const, ...fail('BAD_STATE', '부곡 번호 한도를 넘었습니다.') };
  const id = campaign.nextUnitId++;
  campaign.units.push({
    id,
    ownerId: actor.generalId,
    commanderId: actor.generalId,
    crewType: args.data.crewType,
    troops: 0,
    train: 0,
    atmos: 0,
  });
  campaign.revision++;
  const state = cloneWorld(view);
  state.campaign = readCampaignState(campaign, state);
  return { ok: true as const, state, text: `빈 부곡${id} 편성` };
}

// 새 판에서만 기존 부곡 resolver를 감싼다. 구판은 이 resolver를 만들지 않는다.
export function createCityResourceCommandResolver(base: CommandResolver): CommandResolver {
  function definition(key: string): CommandDef | undefined {
    const original = base.get(key);
    const cityPreparation = key === 'recruit' || key === 'conscript' || key === 'train' || key === 'morale';
    if (!original && key !== 'nation_city_allocate' && key !== 'form_unit') return undefined;
    const custom = key === 'nation_city_allocate' || key === 'form_unit';
    const args =
      key === 'nation_city_allocate'
        ? cityAllocationArgs
        : key === 'form_unit'
          ? formArgs
          : key === 'recruit' || key === 'conscript'
            ? cityRecruitArgs
            : key === 'train' || key === 'morale'
              ? z.union([cityDrillArgs, original!.args])
              : original!.args;
    const cityAction = (view: WorldView, actor: Actor, value: unknown) => {
      if (key === 'nation_city_allocate') return applyCityAllocation(view, actor, value);
      if (key === 'form_unit') return formUnit(view, actor, value);
      if (
        key === 'recruit' ||
        key === 'conscript' ||
        ((key === 'train' || key === 'morale') && value && typeof value === 'object' && 'target' in value)
      ) {
        const denial = checkCampaignActor(view, actor, key);
        return denial
          ? { ok: false as const, ...denial }
          : applyCityPreparation(view, actor, key as 'recruit' | 'conscript' | 'train' | 'morale', value);
      }
      return null;
    };
    const check = (view: WorldView, actor: Actor, value: unknown) => {
      if (!view.ruleFeatures?.includes('city-resources-v1'))
        return fail('COMMAND_DISABLED', '도시 자원을 사용하는 판이 아닙니다.');
      const outcome = cityAction(view, actor, value);
      return outcome ? (outcome.ok ? null : fail(outcome.code, outcome.message)) : original!.check(view, actor, value);
    };
    return {
      ...(original ?? {
        key,
        name: key === 'form_unit' ? '빈 부곡 편성' : '도시 병력 배속',
        category: key === 'form_unit' ? 'military' : 'nation',
        target: key === 'form_unit' ? 'general' : 'nation',
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
        let state = applyEffects(cloneWorld(view), result.effects);
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
      definition(target === 'general' ? 'form_unit' : 'nation_city_allocate')!,
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
