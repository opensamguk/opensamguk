import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import { toGameDate } from '../clock/clock';
import { defineCommand, fail, noArgs, positive, ruler, success, targetGeneral } from '../commands/support';
import type { Actor, CommandDef } from '../commands/types';
import type { WorldView } from '../model/world';
import { refreshSupply } from '../supply';
import { dissolveNation, transferRulership } from './operations';
import { assertNationLifecycle, isWandering, NATION_LIFECYCLE_FEATURE } from './state';

function canAct(world: WorldView, actor: Actor) {
  if (!world.ruleFeatures?.includes(NATION_LIFECYCLE_FEATURE))
    return fail('COMMAND_DISABLED', '이 월드에서는 국가 변천 명령을 쓸 수 없습니다.');
  const denied = ruler(world, actor);
  if (denied) return denied;
  assertNationLifecycle(world);
  return null;
}

export const nationLifecycleCommands: readonly CommandDef[] = [
  defineCommand({
    key: 'abdicate',
    name: '선양',
    category: 'strategy',
    args: z.strictObject({ generalId: positive }),
    check(world, actor, args) {
      const denied = canAct(world, actor);
      if (denied) return denied;
      const general = world.generals[actor.generalId]!,
        target = targetGeneral(world, args.generalId);
      if (!target || target.id === general.id || target.nationId !== general.nationId)
        return fail('BAD_TARGET', '같은 국가의 다른 장수에게만 선양할 수 있습니다.');
      return target.activeFromYear > toGameDate(world.startYear, actor.tick ?? 0).year
        ? fail('BAD_TARGET', '아직 등장하지 않은 장수입니다.')
        : null;
    },
    change(state, actor, args) {
      const general = state.generals[actor.generalId]!,
        target = state.generals[args.generalId]!;
      const effects = transferRulership(state, general.nationId!, general.id, target.id);
      return { ...success(effects.history[0]!.text), ...effects };
    },
  }),
  defineCommand({
    key: 'wander',
    name: '방랑',
    category: 'strategy',
    args: noArgs,
    check(world, actor) {
      const denied = canAct(world, actor);
      if (denied) return denied;
      const nationId = world.generals[actor.generalId]!.nationId!;
      if (isWandering(world, nationId)) return fail('BAD_STATE', '이미 방랑 중입니다.');
      if (Math.floor((actor.tick ?? 0) / TICKS_PER_MONTH) < (world.presetRules?.protection.peaceMonths ?? 0))
        return fail('PROTECTED', '초반 보호 기간에는 방랑할 수 없습니다.');
      return world.diplomacies.some(
        (row) => (row.nationA === nationId || row.nationB === nationId) && ['WAR', 'DECLARED'].includes(row.state),
      )
        ? fail('BAD_STATE', '전쟁·선포 중에는 방랑할 수 없습니다.')
        : null;
    },
    change(state, actor) {
      const nationId = state.generals[actor.generalId]!.nationId!;
      for (const city of Object.values(state.cities)) if (city.nationId === nationId) city.nationId = null;
      state.nationLifecycle!.nations[String(nationId)] = { sinceTick: actor.tick ?? 0 };
      refreshSupply(state);
      const text = `${state.nations[nationId]!.name} 방랑 시작`;
      return { ...success(text), history: [{ nationId, text }] };
    },
  }),
  defineCommand({
    key: 'resettle',
    name: '재정착',
    category: 'strategy',
    args: noArgs,
    check(world, actor) {
      const denied = canAct(world, actor);
      if (denied) return denied;
      const general = world.generals[actor.generalId]!;
      if (!isWandering(world, general.nationId)) return fail('BAD_STATE', '방랑 국가만 재정착할 수 있습니다.');
      const city = world.cities[general.cityKey];
      if (!city || city.kind === 'PASS' || city.nationId !== null || ![5, 6].includes(city.level))
        return fail('BAD_TARGET', '소·중 규모의 빈 도시에서만 재정착할 수 있습니다.');
      return Object.values(world.generals).filter((row) => row.nationId === general.nationId).length < 2
        ? fail('BAD_STATE', '소속 장수가 2명 이상이어야 합니다.')
        : null;
    },
    change(state, actor) {
      const general = state.generals[actor.generalId]!,
        nation = state.nations[general.nationId!]!;
      state.cities[general.cityKey]!.nationId = nation.id;
      nation.capitalCityKey = general.cityKey;
      delete state.nationLifecycle!.nations[String(nation.id)];
      refreshSupply(state);
      const text = `${nation.name}: ${state.cities[general.cityKey]!.name} 재정착`;
      return { ...success(text), history: [{ nationId: nation.id, text }] };
    },
  }),
  defineCommand({
    key: 'disband',
    name: '국가 해산',
    category: 'strategy',
    args: noArgs,
    check(world, actor) {
      const denied = canAct(world, actor);
      if (denied) return denied;
      if (!isWandering(world, world.generals[actor.generalId]!.nationId))
        return fail('BAD_STATE', '방랑 국가만 해산할 수 있습니다.');
      return (actor.tick ?? 0) < TICKS_PER_MONTH ? fail('PROTECTED', '다음 달부터 해산할 수 있습니다.') : null;
    },
    change(state, actor) {
      const effects = dissolveNation(state, state.generals[actor.generalId]!.nationId!);
      return {
        ...success(effects.history[0]!.text),
        ...effects,
        reports: effects.reports.filter((report) => report.generalId !== actor.generalId),
      };
    },
  }),
];
