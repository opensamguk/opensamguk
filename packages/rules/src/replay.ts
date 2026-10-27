import { emptyTurns, validatePolicyInput } from './replayInputs';
export { emptyTurns, applyTurnsInput, applyCreationInput } from './replayInputs';
import { hasRuleFeature, ruleRegistry, settleMonthlyFeatures, type RuleRegistry } from './ruleRegistry';
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

export interface QueuedTurn {
  commandKey: string;
  args: unknown;
  explicit?: boolean;
}
export interface ReplayState {
  state: WorldState;
  turns: Record<number, QueuedTurn[]>;
  revisions: Record<number, number>;
  monthlyTick: number;
  policy?: ReplayPolicy;
  offices?: OfficeRevisions;
  residenceAnchors?: Record<number, number>;
  // 새 부곡 프로필의 불변 병종 허용 목록. 생성 기록의 unitSet에서만 읽는다.
  campaignArmyTypes?: number[];
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
  let replay: ReplayState = {
    state: toWorldState(initial),
    turns: Object.fromEntries(initial.generals.map(({ id }) => [id, emptyTurns()])),
    revisions: Object.fromEntries(initial.generals.map(({ id }) => [id, 0])),
    monthlyTick: 0,
  };
  for (const key of initial.ruleFeatures ?? []) {
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
    .filter((general) => general.activeFromYear <= year)
    .sort((a, b) => a.nextTurnTick - b.nextTurnTick || a.id - b.id)[0];
  return due && due.nextTurnTick < boundary
    ? { kind: 'turn' as const, tick: due.nextTurnTick, generalId: due.id }
    : { kind: 'monthly' as const, tick: boundary };
}

export function runReplayAction(
  replay: ReplayState,
  seed: string,
  unitSet?: UnitSetResource,
  resolver?: CommandResolver,
  registry: RuleRegistry = ruleRegistry,
): ReplayState {
  const action = nextGameAction(replay);
  if (action.kind === 'monthly') {
    const date = monthlyDate(replay.state.startYear, action.tick);
    const result = runMonthly(replay.state, action.tick, rngFor(seed, 'monthly', date.year, date.month));
    return settleMonthlyFeatures(
      replay,
      { ...replay, state: result.state, monthlyTick: action.tick },
      action.tick,
      registry,
    ).replay;
  }
  const next = structuredClone(replay);
  const personnel = Object.hasOwn(replay, 'offices');
  const turns = next.turns[action.generalId] ?? emptyTurns();
  const command = turns[0]!;
  const result = runGeneralTurn(
    next.state,
    { generalId: action.generalId, tick: action.tick, unitSet },
    command,
    seed,
    next.policy ? { policy: next.policy.policies[action.generalId]! } : {},
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
  next.turns[action.generalId] = [...turns.slice(1), next.policy ? emptyTurn() : { commandKey: 'rest', args: {} }];
  next.revisions[action.generalId] = (next.revisions[action.generalId] ?? 0) + 1;
  return next;
}

export function applyRecordedInput(
  replay: ReplayState,
  input: RecordedInput,
  registry: RuleRegistry = ruleRegistry,
): ReplayState {
  if (
    replay.policy &&
    (!replay.state.ruleFeatures ||
      ['turns.set', 'general.create', 'general.setPolicy', 'general.active'].includes(input.kind))
  )
    validatePolicyInput(input, replay.state.ruleFeatures?.includes('five-stats'));
  const kind = registry.inputKinds.find((kind) => kind.kind === input.kind);
  if (input.status === 'REJECTED') {
    if (
      kind?.feature &&
      !hasRuleFeature(replay.state, kind.feature) &&
      !(kind.feature === 'policy' && replay.policy && !replay.state.ruleFeatures)
    ) {
      const result = input.result as { code?: unknown; message?: unknown } | null;
      if (
        !result ||
        result.code !== 'FEATURE_DISABLED' ||
        typeof result.message !== 'string' ||
        Object.keys(result).some((key) => key !== 'code' && key !== 'message')
      )
        throw new Error('끈 기능의 입력 거절 기록이 다릅니다.');
    }
    return replay;
  }
  if (!kind) throw new Error(`재생할 수 없는 입력 종류입니다: ${input.kind}`);
  const legacyPolicy = kind.feature === 'policy' && replay.policy && !replay.state.ruleFeatures;
  if (kind.feature !== null && !hasRuleFeature(replay.state, kind.feature) && !legacyPolicy)
    throw new Error('이 월드에서 켜지 않은 기능입니다.');
  let next = kind.apply(replay, input);
  for (const key of replay.state.ruleFeatures ?? []) {
    if (key === kind.feature) continue;
    const feature = registry.features.find((feature) => feature.key === key);
    next = feature?.afterAppliedInput?.(replay, next, input) ?? next;
  }
  return next;
}
