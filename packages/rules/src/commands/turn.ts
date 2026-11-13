import type { CommandResolver } from './resolve';
import { rngFor } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import { toGameDate } from '../clock/clock';
import type { DeepReadonly, WorldState } from '../model/world';
import type { Actor, CommandResult, Failure } from './types';
import { applyEffects } from './effects';
import { commandRegistry, runCommand } from './registry';
import { chooseAutoplayTurn, chooseGeneralTurn, chooseNationTurn, type NpcContext } from '../npc';
import { runPolicyCommand } from '../policy/execute';
import { applyPersonalityProgress } from '../general/personality';
import { PLAYER_AUTOPLAY_FEATURE, playerAutoplayWindow, type PolicyKey } from '../policy';
import { runOfficeAssign, takeOfficeTurn } from '../personnel/officeTurn';
import { canExecuteNationCommand } from '../personnel/permissions';
import type { OfficeRevisions } from '../personnel/offices';
import { assertTick, PersonnelInvariantError, type ClosedOffer, type PersonnelLog } from '../personnel/types';
import { canExecuteCityNationCommand } from '../cityResources/commands';
import { takeCampaignOrder, finishCampaignOrder } from '../campaign/orders';
import { canExecuteResearchNationCommand } from '../nationResearch/commands';
import { trackNationTurn } from '../preparedTurns/withPrepare';
import { RICE_MARKET_FEATURE } from '../world/riceMarket';

export type PersonnelTurnInput = Readonly<{ offices: DeepReadonly<OfficeRevisions> }>;
export type PersonnelTurnChange = Readonly<{
  offices: OfficeRevisions;
  closedOffers: ClosedOffer[];
  logs: PersonnelLog[];
}>;

function applyLastNationRecruitmentLock(state: WorldState, result: CommandResult | Failure, tick: number) {
  const lock = state.commandMeta?.lastNationRecruitmentLock;
  if (lock === undefined || lock.blockedNationId !== undefined) return;
  const defender = 'code' in result ? undefined : result.attackTarget?.defendingNationId;
  if (defender == null || state.nations[defender] || toGameDate(state.startYear, tick).year < lock.fromYear) return;
  const remaining = Object.values(state.nations);
  if (remaining.length === 1) lock.blockedNationId = remaining[0]!.id;
}

export function runGeneralTurn(
  state: WorldState,
  actor: Actor,
  command: { commandKey: string; args: unknown; explicit?: boolean },
  seed: string,
  options: Pick<NpcContext, 'convergence'> & {
    policy?: PolicyKey;
    turnRevision?: number;
    activity?: { lastActiveTick: number; turnTermMinutes: number };
  } = {},
  resolver?: CommandResolver,
  personnel?: PersonnelTurnInput,
): {
  state: WorldState;
  result: CommandResult | Failure;
  nation: { commandKey: string; result: CommandResult | Failure; nationId: number } | undefined;
  commandKey: string;
  personnel?: PersonnelTurnChange;
} {
  if (state.ruleFeatures?.includes(RICE_MARKET_FEATURE)) actor = { ...actor, worldSeed: seed };
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
  const context = { ...options, tick: actor.tick ?? 0, unitSet: actor.unitSet, worldSeed: actor.worldSeed, resolver };
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
        !canExecuteCityNationCommand(next, take.officerLevel, slot.commandKey) &&
        !canExecuteResearchNationCommand(next, take.officerLevel, slot.commandKey)
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
      next = trackNationTurn(
        next,
        { nationId: take.nationId, officerLevel: take.officerLevel },
        slot.commandKey,
        result,
      );
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
  const instructed = takeCampaignOrder(next, actor.generalId, options.turnRevision, command, actor.tick ?? 0);
  next = instructed.state as WorldState;
  let selected = instructed.order ? { ...instructed.order.command, explicit: true } : command;
  const emptyHumanTurn = !instructed.order && general.userId !== null && command.explicit === false;
  const tick = actor.tick ?? 0;
  let autoplay;
  if (emptyHumanTurn && options.activity && next.ruleFeatures?.includes(PLAYER_AUTOPLAY_FEATURE)) {
    const { startsAtTick, expiresAtTick } = playerAutoplayWindow(
      options.activity.lastActiveTick,
      options.activity.turnTermMinutes,
    );
    if (tick >= startsAtTick && tick < expiresAtTick)
      autoplay = chooseAutoplayTurn(
        next,
        next.generals[actor.generalId]!,
        rngFor(seed, 'player-autoplay', tick, actor.generalId),
        context,
      );
  }
  if (autoplay) selected = { commandKey: autoplay.key, args: autoplay.args };
  if (emptyHumanTurn && !autoplay && options.policy !== undefined) {
    const policy = runPolicyCommand(next, { ...actor, target: 'general' }, options.policy, seed, resolver);
    const before = next.generals[actor.generalId]!;
    next = applyEffects(next, policy.result.effects);
    applyPersonalityProgress(next, next.generals[actor.generalId]!, before);
    applyLastNationRecruitmentLock(next, policy.result, actor.tick ?? 0);
    return {
      state: next,
      result: policy.result,
      nation,
      commandKey: policy.commandKey,
      ...(personnelChange === undefined ? {} : { personnel: personnelChange }),
    };
  }
  if (
    !instructed.order &&
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
  const before = next.generals[actor.generalId]!;
  const result = run(
    next,
    { ...actor, target: 'general', ...(instructed.order ? { campaignOrderId: instructed.order.id } : {}) },
    selected.commandKey,
    selected.args,
    rngFor(seed, 'turn', actor.tick ?? 0, actor.generalId),
  );
  next = applyEffects(next, 'code' in result ? [] : result.effects);
  applyPersonalityProgress(next, next.generals[actor.generalId]!, before);
  applyLastNationRecruitmentLock(next, result, actor.tick ?? 0);
  if (instructed.order)
    next = finishCampaignOrder(
      next,
      instructed.order.id,
      actor.tick ?? 0,
      'code' in result,
      'code' in result
        ? `${result.code}: ${result.message}`
        : result.logs.map((log) => log.text).join('\n') || '명령을 실행했습니다.',
    );
  return {
    state: next,
    result,
    nation,
    commandKey: selected.commandKey,
    ...(personnelChange === undefined ? {} : { personnel: personnelChange }),
  };
}
