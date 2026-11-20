// core2026 df6c926 nation/che_증축·che_감축, MIT © 2025 devsam (resources/NOTICE.md).
import { z } from 'zod';
import type { Actor, CommandDef } from '../commands/types';
import type { WorldView } from '../model/world';
import { cloneWorld } from '../model/clone';
import { withPrepare } from '../preparedTurns/withPrepare';
import { cityUpgradeInfo, completeCityUpgrade, CITY_UPGRADE_RULES } from './upgrade';

const args = z.strictObject({ cityKey: z.number().int().positive().max(2_147_483_647) });
function defineResize(commandKey: 'nation_expand' | 'nation_shrink'): CommandDef {
  const expanding = commandKey === 'nation_expand',
    name = expanding ? '증축' : '감축';
  const check = (world: WorldView, actor: Actor, raw: unknown) => {
    const input = args.parse(raw),
      info = cityUpgradeInfo(world, input.cityKey, actor);
    return expanding ? info.expand.failure : info.shrink.failure;
  };
  const prepared = withPrepare(
    {
      key: commandKey,
      name,
      target: 'nation',
      category: 'nation',
      args,
      precheck: check,
      check,
      execute(world, actor, raw) {
        const input = args.parse(raw),
          denied = check(world, actor, input);
        if (denied) throw new Error(denied.message);
        const state = cloneWorld(world),
          city = state.cities[input.cityKey]!;
        const info = cityUpgradeInfo(world, input.cityKey, actor);
        const nextLevel = expanding ? info.expand.nextLevel! : info.shrink.previousLevel!;
        const cityResize = { cityKey: input.cityKey, fromLevel: city.level, nextLevel };
        completeCityUpgrade(state, input.cityKey, nextLevel);
        const nation = state.nations[state.generals[actor.generalId]!.nationId!]!;
        nation.gold += expanding ? -CITY_UPGRADE_RULES.cost : CITY_UPGRADE_RULES.refund;
        const text = `${city.name} ${name} 완료`;
        return {
          effects: [{ kind: 'world', state }],
          cityResize,
          logs: [{ kind: 'success', text }],
          history: [{ nationId: nation.id, text }],
        };
      },
    },
    { preReqTurn: CITY_UPGRADE_RULES.turns - 1 },
  );
  return {
    ...prepared,
    check(world, actor, raw) {
      const input = args.parse(raw),
        general = world.generals[actor.generalId],
        record = world.preparedTurns?.nations[general?.nationId ?? 0]?.[general?.officerLevel ?? 0];
      if (
        record?.commandKey === commandKey &&
        record.term >= CITY_UPGRADE_RULES.turns - 1 &&
        record.args &&
        typeof record.args === 'object' &&
        !Array.isArray(record.args) &&
        'cityKey' in record.args &&
        record.args.cityKey === input.cityKey &&
        record.cityLevel !== undefined &&
        world.cities[input.cityKey]?.level !== record.cityLevel
      )
        return { code: 'BAD_STATE', message: '준비하는 동안 이 도시 규모가 바뀌었습니다.', clearPreparation: true };
      return check(world, actor, input);
    },
    execute(world, actor, raw, rng) {
      const input = args.parse(raw),
        general = world.generals[actor.generalId]!,
        previous = world.preparedTurns?.nations[general.nationId!]?.[general.officerLevel],
        result = prepared.execute(world, actor, input, rng);
      for (const effect of result.effects) {
        if (effect.kind !== 'world') continue;
        const record = effect.state.preparedTurns?.nations[general.nationId!]?.[general.officerLevel];
        if (record)
          record.cityLevel =
            record.term > 1
              ? (previous?.cityLevel ?? world.cities[input.cityKey]!.level)
              : world.cities[input.cityKey]!.level;
      }
      return result;
    },
  };
}
export const cityUpgradeCommands = [defineResize('nation_expand'), defineResize('nation_shrink')];
