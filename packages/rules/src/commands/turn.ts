import type { CommandResolver } from './resolve';
import { rngFor } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { DeepReadonly, WorldState } from '../model/world';
import type { Actor, CommandResult, Failure } from './types';
import { applyEffects } from './effects';
import { commandRegistry, runCommand } from './registry';
import { chooseGeneralTurn, chooseNationTurn, type NpcContext } from '../npc';
import { runPolicyCommand } from '../policy/execute';
import type { PolicyKey } from '../policy';
import { runOfficeAssign, takeOfficeTurn } from '../personnel/officeTurn';
import { canExecuteNationCommand } from '../personnel/permissions';
import type { OfficeRevisions } from '../personnel/offices';
import { assertTick, PersonnelInvariantError, type ClosedOffer, type PersonnelLog } from '../personnel/types';
import { canExecuteCityNationCommand } from '../cityResources/commands';

export type PersonnelTurnInput = Readonly<{ offices: DeepReadonly<OfficeRevisions> }>;
export type PersonnelTurnChange = Readonly<{
  offices: OfficeRevisions;
  closedOffers: ClosedOffer[];
  logs: PersonnelLog[];
}>;

export function runGeneralTurn(
  state: WorldState,
  actor: Actor,
  command: { commandKey: string; args: unknown; explicit?: boolean },
  seed: string,
  options: Pick<NpcContext, 'convergence'> & { policy?: PolicyKey } = {},
  resolver?: CommandResolver,
  personnel?: PersonnelTurnInput,
): {
  state: WorldState;
  result: CommandResult | Failure;
  nation: { commandKey: string; result: CommandResult | Failure; nationId: number } | undefined;
  commandKey: string;
  personnel?: PersonnelTurnChange;
} {
  if (personnel !== undefined) {
    if (Object.hasOwn(state, 'nationTurns'))
      throw new PersonnelInvariantError('인사 기능을 켠 월드에 국가 예턴이 있습니다.');
    assertTick(actor.tick as number);
  }
  const take = personnel === undefined ? null : takeOfficeTurn(state, personnel.offices, actor.generalId);
  const personnelChange: PersonnelTurnChange | undefined =
    personnel === undefined
      ? undefined
      : {
          offices: take?.offices ?? (structuredClone(personnel.offices) as OfficeRevisions),
          closedOffers: [],
          logs: [],
        };
  const run = resolver ? resolver.run.bind(resolver) : runCommand;
  const general = state.generals[actor.generalId]!;
  const nationId = general.nationId;
  let next = state;
  let nation: { commandKey: string; result: CommandResult | Failure; nationId: number } | undefined;
  // 국가 예턴은 턴 시작 시 군주가 한 번만 실행한다. 국가 명령 뒤 장수 명령을 재검사한다.
  const npcNation = general.userId === null && nationId !== null && state.nations[nationId]?.isNpc;
  const context = { ...options, tick: actor.tick ?? 0, unitSet: actor.unitSet, resolver };
  if (personnelChange) {
    if (take) {
      let slot = take.slot;
      if (
        npcNation &&
        slot.commandKey === 'nation_rest' &&
        commandRegistry.get('nation_rest')!.args.safeParse(slot.args).success
      ) {
        const decision = chooseNationTurn(
          next,
          general,
          rngFor(seed, 'npc-nation', actor.tick!, take.nationId),
          context,
        );
        if (decision.chosen) slot = { commandKey: decision.chosen.key, args: decision.chosen.args };
      }
      if (
        !canExecuteNationCommand(take.officerLevel, slot.commandKey) &&
        !canExecuteCityNationCommand(next, take.officerLevel, slot.commandKey)
      )
        throw new PersonnelInvariantError('직책 칸 명령과 인자가 올바르지 않습니다.');
      let result: CommandResult | Failure;
      if (slot.commandKey === 'nation_assign') {
        const assigned = runOfficeAssign(next, actor, slot.args, actor.tick!);
        result = assigned.result;
        personnelChange.closedOffers.push(...assigned.closedOffers);
        personnelChange.logs.push(...assigned.logs);
      } else {
        result = run(
          next,
          { ...actor, target: 'nation', authority: 'office' },
          slot.commandKey,
          slot.args,
          rngFor(seed, 'nation-turn', actor.tick!, take.nationId),
        );
      }
      next = applyEffects(next, 'code' in result ? [] : result.effects);
      if (next.nations[take.nationId] && take.queue) {
        next.officeTurns ??= {};
        (next.officeTurns[take.nationId] ??= {})[take.officerLevel] = take.queue;
      }
      nation = { commandKey: slot.commandKey, result, nationId: take.nationId };
    }
  } else if (
    nationId !== null &&
    general.officerLevel === BALANCE.RULER_LEVEL &&
    (state.nationTurns?.[nationId] || npcNation)
  ) {
    const queue = state.nationTurns?.[nationId];
    let slot = queue?.[0] ?? { commandKey: 'nation_rest', args: {} };
    if (
      npcNation &&
      slot.commandKey === 'nation_rest' &&
      commandRegistry.get('nation_rest')!.args.safeParse(slot.args).success
    ) {
      const decision = chooseNationTurn(next, general, rngFor(seed, 'npc-nation', actor.tick ?? 0, nationId), context);
      if (decision.chosen) slot = { commandKey: decision.chosen.key, args: decision.chosen.args };
    }
    const result = run(
      next,
      { ...actor, target: 'nation' },
      slot.commandKey,
      slot.args,
      rngFor(seed, 'nation-turn', actor.tick ?? 0, nationId),
    );
    next = applyEffects(next, 'code' in result ? [] : result.effects);
    if (queue && next.nations[nationId]) {
      next.nationTurns ??= {};
      next.nationTurns[nationId] = Array.from(
        { length: 30 },
        (_, slot) => queue[slot + 1] ?? { commandKey: 'nation_rest', args: {} },
      );
    }
    nation = { commandKey: slot.commandKey, result, nationId };
  }
  let selected = command;
  if (general.userId !== null && command.explicit === false && options.policy !== undefined) {
    const policy = runPolicyCommand(next, { ...actor, target: 'general' }, options.policy, seed, resolver);
    next = applyEffects(next, policy.result.effects);
    return {
      state: next,
      result: policy.result,
      nation,
      commandKey: policy.commandKey,
      ...(personnelChange === undefined ? {} : { personnel: personnelChange }),
    };
  }
  if (
    general.userId === null &&
    command.commandKey === 'rest' &&
    commandRegistry.get('rest')!.args.safeParse(command.args).success
  ) {
    const decision = chooseGeneralTurn(
      next,
      next.generals[actor.generalId]!,
      rngFor(seed, 'npc', actor.tick ?? 0, actor.generalId),
      context,
    );
    if (decision.chosen) selected = { commandKey: decision.chosen.key, args: decision.chosen.args };
  }
  const result = run(
    next,
    { ...actor, target: 'general' },
    selected.commandKey,
    selected.args,
    rngFor(seed, 'turn', actor.tick ?? 0, actor.generalId),
  );
  next = applyEffects(next, 'code' in result ? [] : result.effects);
  return {
    state: next,
    result,
    nation,
    commandKey: selected.commandKey,
    ...(personnelChange === undefined ? {} : { personnel: personnelChange }),
  };
}
