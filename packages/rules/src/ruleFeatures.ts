import { z } from 'zod';
import { FIVE_STAT_KEYS, FIVE_STAT_RULES, checkStatProfile } from './general/fiveStats';
import { validateGeneralCreation } from './general/create';
import type { InputKindDefinition, RuleFeatureDefinition } from './ruleRegistry';
import type { RecordedInput, ReplayState } from './replay';
import { enableReplayPolicy } from './policy/replay';
import { applyPersonnelRecordStep } from './personnel/inputStep';
import { validatePersonnelRecord } from './personnel/inputs';
import { runPersonnelMonth } from './personnel/monthStep';
import { updateResidenceAnchors } from './personnel/residence';
import { completePersonnelStep, type PersonnelStepPacket } from './personnel/step';
import { applyTreatyInput, settleTreaties, validateTreatyRecord } from './diplomacy/treaty';
import { validatePolicyInput } from './replayInputs';
import { trade } from './commands/trade';
import { checkOperationalProfile } from './world/map/profile';

export const operationalMapFeature: RuleFeatureDefinition = {
  key: 'operational-map',
  requires: ['five-stats'],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (data !== undefined) throw new Error('운영 지도는 생성 기록의 불변 원장을 사용합니다.');
    checkOperationalProfile(initial);
  },
};

export const fiveStatsFeature: RuleFeatureDefinition = {
  key: 'five-stats',
  requires: [],
  conflicts: [],
  checkOrigin({ initial, data }) {
    if (data !== undefined) throw new Error('5능력치 기능의 별도 초기 자료는 없습니다.');
    checkStatProfile(initial);
  },
  checkArchive({ inputs }) {
    for (const input of inputs) {
      if (input.kind !== 'general.create' || input.status !== 'APPLIED') continue;
      const parsed = validateGeneralCreation(input.payload, FIVE_STAT_RULES);
      const general = (input.result as { general?: Record<string, unknown> } | null)?.general;
      if (!parsed.ok || !general || FIVE_STAT_KEYS.some((key) => general[key] !== parsed.value[key]))
        throw new Error('5능력치 생성 입력과 결과가 다릅니다.');
    }
  },
};

const tickSchema = z.number().int().min(0).max(2_147_483_647);
const policyDataSchema = z.strictObject({ version: z.literal(1), turnTermMinutes: tickSchema.min(1) });

export const policyFeature: RuleFeatureDefinition = {
  key: 'policy',
  requires: [],
  conflicts: [],
  checkOrigin({ data }) {
    policyDataSchema.parse(data);
  },
  checkArchive({ origin, inputs }) {
    for (const input of inputs)
      if (['turns.set', 'general.create', 'general.setPolicy', 'general.active'].includes(input.kind))
        validatePolicyInput(input, origin.initial.ruleFeatures?.includes('five-stats'));
  },
  initReplayState(replay, { data }) {
    const config = policyDataSchema.parse(data);
    const human = Object.values(replay.state.generals).some((general) => general.userId !== null);
    return enableReplayPolicy(replay, config.turnTermMinutes, human ? 0 : null);
  },
};

function personnelState(replay: ReplayState) {
  if (!replay.offices || !replay.residenceAnchors) throw new Error('인사의 직책과 물리 거주 앵커가 없습니다.');
  return { offices: replay.offices, anchors: replay.residenceAnchors };
}

function personnelResult(before: ReplayState, after: ReplayState, packet: PersonnelStepPacket, input: RecordedInput) {
  const current = personnelState(before);
  const tick = tickSchema.parse(input.tick);
  return {
    ...after,
    state: packet.state,
    offices: packet.offices,
    residenceAnchors: updateResidenceAnchors({
      before: before.state,
      after: packet.state,
      anchors: current.anchors,
      tick,
      createdHumanId: input.kind === 'general.create' ? input.generalId : null,
    }),
  };
}

export const personnelFeature: RuleFeatureDefinition = {
  key: 'personnel',
  requires: [],
  conflicts: ['ext'],
  checkOrigin({ initial, data }) {
    if (data !== undefined || initial.generals.some((general) => general.userId !== null))
      throw new Error('인사 생성 기록에는 기존 사람 장수나 추정 앵커를 넣을 수 없습니다.');
    if (['assignmentOffers', 'officeTurns', 'offices', 'residenceAnchors'].some((key) => Object.hasOwn(initial, key)))
      throw new Error('인사 생성 기록의 초기 저장 상태를 확인하세요.');
  },
  initReplayState(replay) {
    return { ...replay, offices: {}, residenceAnchors: {} };
  },
  checkArchive({ origin, inputs, end }) {
    for (const input of inputs) {
      if (!['personnel.appoint', 'personnel.dismiss', 'offer.respond', 'nationTurns.set'].includes(input.kind))
        continue;
      const { tick, ...record } = input;
      const { activeTick, ...result } = record.result as Record<string, unknown>;
      const validated = validatePersonnelRecord(
        { ...record, result },
        {
          monthlyTick: 0,
          ...(end && input.sequence > end.sequence ? { endTick: end.tick } : {}),
        },
      );
      if (validated.kind !== 'nationTurns.set' && validated.result.tick !== tick)
        throw new Error('인사 처리 tick이 기록과 다릅니다.');
      if (
        validated.kind === 'nationTurns.set' &&
        validated.status === 'APPLIED' &&
        origin.initial.ruleFeatures?.includes('policy')
      ) {
        if (activeTick !== tick) throw new Error('직책 칸 저장 활동 tick이 다릅니다.');
      } else if (activeTick !== undefined) throw new Error('활동을 기록하지 않는 인사 입력입니다.');
    }
  },
  afterAppliedInput(before, after, input) {
    if (input.kind === 'turns.set') return after;
    const current = personnelState(before);
    const packet = completePersonnelStep(
      before.state,
      current.offices,
      {
        state: after.state,
        offices: current.offices,
        closedOffers: [],
        logs: [],
      },
      tickSchema.parse(input.tick),
    );
    return personnelResult(before, after, packet, input);
  },
  settleMonthly({ before, settled, tick }) {
    const current = personnelState(before);
    const result = runPersonnelMonth({
      before: before.state,
      startOffices: current.offices,
      settled: settled.state,
      anchors: current.anchors,
      tick,
    });
    return {
      replay: {
        ...settled,
        state: result.packet.state,
        offices: result.packet.offices,
        residenceAnchors: result.anchors,
      },
      effects: result,
    };
  },
};

function applyPersonnel(replay: ReplayState, input: RecordedInput): ReplayState {
  const current = personnelState(replay);
  const { tick, ...record } = input;
  const result = record.result as Record<string, unknown>;
  const { activeTick, ...personnelRecordResult } = result;
  const validated = validatePersonnelRecord(
    { ...record, result: personnelRecordResult },
    { monthlyTick: replay.monthlyTick },
  );
  const step = applyPersonnelRecordStep(
    { state: replay.state, offices: current.offices },
    validated,
    tickSchema.parse(tick),
  );
  const next = personnelResult(replay, replay, step.packet, input);
  if (input.kind === 'nationTurns.set' && next.policy) {
    if (activeTick !== tick || input.generalId === null || next.state.generals[input.generalId]?.userId == null)
      throw new Error('직책 칸 저장 활동 tick이 다릅니다.');
    next.policy = structuredClone(next.policy);
    next.policy.lastActiveTicks[input.generalId] = Math.max(next.policy.lastActiveTicks[input.generalId]!, tick!);
  } else if (activeTick !== undefined) throw new Error('활동을 기록하지 않는 인사 입력입니다.');
  return next;
}

export const personnelInputKinds: readonly InputKindDefinition[] = [
  ...['personnel.appoint', 'personnel.dismiss', 'offer.respond'].map((kind): InputKindDefinition => ({
    kind,
    feature: 'personnel',
    route: 'queued',
    apply: applyPersonnel,
  })),
  { kind: 'nationTurns.set', feature: 'personnel', route: 'direct', directTick: true, apply: applyPersonnel },
];

export const treatyFeature: RuleFeatureDefinition = {
  key: 'treaty',
  requires: [],
  conflicts: [],
  checkOrigin({ data, initial }) {
    if (data !== undefined || Object.hasOwn(initial, 'treaties')) throw new Error('조약 초기 상태를 확인하세요.');
  },
  checkArchive({ origin, inputs, end }) {
    for (const input of inputs) {
      if (!['treaty.propose', 'treaty.respond'].includes(input.kind)) continue;
      const { tick, ...record } = input;
      const validated = validateTreatyRecord(record, {
        treaty: { version: 1 },
        ...(origin.initial.ruleFeatures?.includes('treaty-trade') ? { treatyTrade: { version: 1 } } : {}),
        monthlyTick: 0,
        ...(end && input.sequence > end.sequence ? { endTick: end.tick } : {}),
      });
      if (validated.result.tick !== tick) throw new Error('조약 처리 tick이 기록과 다릅니다.');
    }
  },
  settleMonthly({ settled, tick }) {
    return { replay: { ...settled, state: settleTreaties(settled.state, tick) }, effects: null };
  },
};

export const treatyBreakFeature: RuleFeatureDefinition = {
  key: 'treaty-break',
  requires: ['treaty'],
  conflicts: [],
  checkOrigin({ data, initial }) {
    if (data !== undefined || Object.hasOwn(initial, 'nationTrust'))
      throw new Error('조약 파기 초기 상태를 확인하세요.');
  },
  checkArchive({ origin, inputs, end }) {
    for (const input of inputs) {
      if (input.kind !== 'treaty.break') continue;
      const { tick, ...record } = input;
      const validated = validateTreatyRecord(record, {
        treaty: { version: 1 },
        treatyBreak: { version: 1 },
        ...(origin.initial.ruleFeatures?.includes('treaty-trade') ? { treatyTrade: { version: 1 } } : {}),
        monthlyTick: 0,
        ...(end && input.sequence > end.sequence ? { endTick: end.tick } : {}),
      });
      if (validated.result.tick !== tick) throw new Error('조약 파기 처리 tick이 기록과 다릅니다.');
    }
  },
};

export const treatyTradeFeature: RuleFeatureDefinition = {
  key: 'treaty-trade',
  requires: ['treaty'],
  conflicts: [],
  commandBindings: [{ definition: trade, sliceKeys: [] }],
  checkOrigin({ data }) {
    if (data !== undefined) throw new Error('교역 기능의 초기 자료를 확인하세요.');
  },
};

function applyTreaty(replay: ReplayState, input: RecordedInput): ReplayState {
  const { tick, ...record } = input;
  const context = {
    treaty: { version: 1 as const },
    ...(replay.state.ruleFeatures?.includes('treaty-break') ? { treatyBreak: { version: 1 as const } } : {}),
    ...(replay.state.ruleFeatures?.includes('treaty-trade') ? { treatyTrade: { version: 1 as const } } : {}),
    monthlyTick: replay.monthlyTick,
  };
  const validated = validateTreatyRecord(record, context);
  if (validated.status !== 'APPLIED' || validated.result.tick !== tick) throw new Error('조약 처리 tick이 다릅니다.');
  const result = applyTreatyInput(replay.state, validated, {
    tick: tickSchema.parse(tick),
    sequence: validated.sequence,
    tradeEnabled: replay.state.ruleFeatures?.includes('treaty-trade') ?? false,
  });
  if (!result.ok) throw new Error('조약 적용 기록을 재현하지 못했습니다.');
  const recomputed = validateTreatyRecord({ ...validated, result: result.result }, context);
  if (JSON.stringify(validated.result) !== JSON.stringify(recomputed.result))
    throw new Error('조약 적용 결과가 기록과 다릅니다.');
  return { ...replay, state: result.state };
}

export const treatyInputKinds: readonly InputKindDefinition[] = ['treaty.propose', 'treaty.respond'].map((kind) => ({
  kind,
  feature: 'treaty',
  route: 'queued',
  apply: applyTreaty,
}));

export const treatyBreakInputKind: InputKindDefinition = {
  kind: 'treaty.break',
  feature: 'treaty-break',
  route: 'queued',
  apply: applyTreaty,
};
