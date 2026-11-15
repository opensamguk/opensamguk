import { providedRuleData } from './providedRuleData';
import { emptyTurns, validatePolicyInput } from './replayInputs';
import { ruleRegistry, settleMonthlyFeatures, type RuleRegistry } from './ruleRegistry';
import type { CommandResolver } from './commands/resolve';
import { resolverForRuleFeatures } from './ruleCommands';
import { rngFor } from '@opensamguk/shared';
import { runGeneralTurn } from './commands/turn';
import type { UnitSetResource } from './world/resources';
import { TICKS_PER_MONTH } from './clock/constants';
import { toWorldState, type WorldState, type OfficeRevisions } from './model/world';
import { monthlyDate, runMonthly } from './monthly/index';
import type { WorldInit } from './world/bootstrap';
import { emptyTurn } from './policy';
import { type ReplayPolicy } from './policy/replay';
import { completePersonnelStep } from './personnel/step';
import { updateResidenceAnchors } from './personnel/residence';
import { isAdminClockKind, applyAdminClockRecord } from './clock/admin';
import { isAdminGameKind } from './admin/game';
import type { ReputationLedger } from './review/schema';
import { reputationTurnEvents } from './review/events';
import { appendReputationEvents } from './review/ledger';
import { isAdminSettingKind, validateAdminSettingRecord } from './admin/settings';
import { validateAdminGameRecord } from './admin/apply';
import { POSSESSION_KIND, validatePossessionRecord } from './entry/possess';
export { emptyTurns, applyTurnsInput, applyCreationInput } from './replayInputs';

export interface QueuedTurn {
  commandKey: string;
  args: unknown;
  explicit?: boolean;
}
export interface ReplayState {
  reputation?: ReputationLedger;
  state: WorldState;
  turns: Record<number, QueuedTurn[]>;
  revisions: Record<number, number>;
  monthlyTick: number;
  policy?: ReplayPolicy;
  offices?: OfficeRevisions;
  residenceAnchors?: Record<number, number>;
  // 새 부곡 프로필의 불변 병종 허용 목록. 생성 기록의 unitSet에서만 읽는다.
  campaignArmyTypes?: number[];
  campaignUnitSet?: UnitSetResource;
  lineageResources?: import('./lineage/birth').LineageResources;
}
export interface RecordedInput {
  sequence: number;
  tick?: number | null;
  generalId: number | null;
  kind: string;
  status: 'APPLIED' | 'REJECTED';
  payload: unknown;
  result: unknown;
}

export function initialReplayState(initial: WorldInit, featureData?: ReplayOriginData): ReplayState {
  return initialReplayStateWithRegistry(initial, ruleRegistry, featureData);
}

type ReplayOriginData = Record<string, import('./model/world').JsonValue>;
export function initialReplayStateWithRegistry(
  initial: WorldInit,
  registry: RuleRegistry,
  featureData?: ReplayOriginData,
): ReplayState {
  featureData = { ...providedRuleData(initial, 60), ...featureData };
  let replay: ReplayState = {
    state: toWorldState(initial),
    turns: Object.fromEntries(initial.generals.map(({ id }) => [id, emptyTurns()])),
    revisions: Object.fromEntries(initial.generals.map(({ id }) => [id, 0])),
    monthlyTick: 0,
  };
  for (const key of registry.features.map((feature) => feature.key).sort()) {
    const feature = registry.features.find((feature) => feature.key === key);
    if (!feature) throw new Error(`모르는 규칙 기능입니다: ${key}`);
    replay = feature.initReplayState?.(replay, { initial, data: featureData?.[key] }) ?? replay;
  }
  return replay;
}

export function nextGameAction(replay: ReplayState) {
  const boundary = replay.monthlyTick + TICKS_PER_MONTH;
  const year = monthlyDate(replay.state.startYear, boundary).year;
  const due = Object.values(replay.state.generals)
    .filter((general) => general.removedAt === undefined && general.activeFromYear <= year)
    .sort((a, b) => a.nextTurnTick - b.nextTurnTick || a.id - b.id)[0];
  return due && due.nextTurnTick < boundary
    ? { kind: 'turn' as const, tick: due.nextTurnTick, generalId: due.id }
    : { kind: 'monthly' as const, tick: boundary };
}

export function settleReplayMonth(
  replay: ReplayState,
  seed: string,
  tick: number,
  registry: RuleRegistry = ruleRegistry,
) {
  const date = monthlyDate(replay.state.startYear, tick);
  const result = runMonthly(
    replay.state,
    tick,
    rngFor(seed, 'monthly', date.year, date.month),
    rngFor(seed, 'city-disaster', date.year, date.month),
  );
  return settleMonthlyFeatures(replay, { ...replay, state: result.state, monthlyTick: tick }, tick, registry, seed);
}

export function runReplayAction(
  replay: ReplayState,
  seed: string,
  unitSet?: UnitSetResource,
  resolver?: CommandResolver,
  registry: RuleRegistry = ruleRegistry,
): ReplayState {
  return replayAction(replay, seed, unitSet, resolver, registry, false).replay;
}

/** 읽은 아카이브의 작업 상태는 재생 루프만 소유한다. */
export function runArchiveReplayAction(
  replay: ReplayState,
  seed: string,
  unitSet: UnitSetResource,
  registry: RuleRegistry,
): ReplayState {
  return replayAction(replay, seed, unitSet, undefined, registry, registry === ruleRegistry).replay;
}

export function runSimulationAction(replay: ReplayState, seed: string, unitSet: UnitSetResource, convergence: boolean) {
  return replayAction(replay, seed, unitSet, undefined, ruleRegistry, false, convergence);
}

function replayAction(
  replay: ReplayState,
  seed: string,
  unitSet: UnitSetResource | undefined,
  resolver: CommandResolver | undefined,
  registry: RuleRegistry,
  ownsArchiveState: boolean,
  convergence?: boolean,
): { replay: ReplayState; commandKey?: string; nationCommandKey?: string } {
  const action = nextGameAction(replay);
  if (action.kind === 'monthly') {
    return { replay: settleReplayMonth(replay, seed, action.tick, registry).replay };
  }
  // 보관 루프에서는 규칙이 새 상태를 만들 때까지 직전 월드 상태를 읽는다.
  const next = ownsArchiveState
    ? {
        ...structuredClone({ ...replay, state: undefined, turns: {} }),
        state: replay.state,
        turns: { ...replay.turns },
      }
    : structuredClone(replay);
  const personnel = Object.hasOwn(replay, 'offices');
  const queue = next.turns[action.generalId] ?? emptyTurns();
  const turns = ownsArchiveState ? structuredClone(queue) : queue;
  const command = turns[0]!;
  const result = runGeneralTurn(
    next.state,
    { generalId: action.generalId, tick: action.tick, unitSet },
    command,
    seed,
    {
      ...(next.policy ? { policy: next.policy.policies[action.generalId]! } : {}),
      turnRevision: next.revisions[action.generalId] ?? 0,
      ...(convergence === undefined ? {} : { convergence }),
    },
    resolver ?? resolverForRuleFeatures(next.state, registry),
    personnel ? { offices: next.offices! } : undefined,
  );
  next.state = result.state;
  next.state.generals[action.generalId]!.nextTurnTick += TICKS_PER_MONTH;
  if (personnel) {
    const packet = completePersonnelStep(
      replay.state,
      replay.offices!,
      { state: next.state, ...result.personnel! },
      action.tick,
    );
    next.state = packet.state;
    next.offices = packet.offices;
    if (replay.residenceAnchors)
      next.residenceAnchors = updateResidenceAnchors({
        before: replay.state,
        after: next.state,
        anchors: replay.residenceAnchors,
        tick: action.tick,
        createdHumanId: null,
      });
  }
  {
    if (!next.reputation) throw Error('월단평 재생 원장이 없습니다.');
    next.reputation = appendReputationEvents(
      next.reputation,
      reputationTurnEvents({
        before: replay.state,
        after: next.state,
        generalId: action.generalId,
        tick: action.tick,
        commandKey: result.commandKey,
        result: result.result,
      }),
    );
  }
  next.turns[action.generalId] = [...turns.slice(1), next.policy ? emptyTurn() : { commandKey: 'rest', args: {} }];
  next.revisions[action.generalId] = (next.revisions[action.generalId] ?? 0) + 1;
  return {
    replay: next,
    commandKey: result.commandKey,
    ...(result.nation ? { nationCommandKey: result.nation.commandKey } : {}),
  };
}

export function applyRecordedInput(
  replay: ReplayState,
  input: RecordedInput,
  registry: RuleRegistry = ruleRegistry,
  context?: { unitSet?: UnitSetResource },
): ReplayState {
  if (isAdminClockKind(input.kind)) return applyAdminClockRecord(replay, input);
  if (isAdminGameKind(input.kind)) validateAdminGameRecord(input);
  if (isAdminSettingKind(input.kind)) validateAdminSettingRecord(input);
  if (input.kind === POSSESSION_KIND) validatePossessionRecord(input);
  if (replay.policy && ['turns.set', 'general.create', 'general.setPolicy', 'general.active'].includes(input.kind))
    validatePolicyInput(input, true, true, true);
  const kind = registry.inputKinds.find((kind) => kind.kind === input.kind);
  if (input.status === 'REJECTED') return replay;
  if (!kind) throw new Error(`알 수 없는 입력 종류입니다: ${input.kind}`);
  let next =
    input.kind === 'campaign.order'
      ? kind.apply(replay, input, { ...context, resolver: resolverForRuleFeatures(replay.state, registry) })
      : kind.apply(replay, input, context);
  const features = registry.features.map((feature) => feature.key).sort();
  // 엄격한 후속 적재 전에 멸망·거점 소유 변경에 따른 계략 패를 정리한다.
  const ordered = ['stratagem-cards-v1', ...features.filter((key) => key !== 'stratagem-cards-v1')];
  for (const key of ordered) {
    if (key === kind.feature) continue;
    const feature = registry.features.find((feature) => feature.key === key);
    next =
      feature?.afterAppliedInput?.(replay, next, input, {
        route: input.kind === 'battle.step' ? 'queued' : kind.route,
      }) ?? next;
  }
  return next;
}
