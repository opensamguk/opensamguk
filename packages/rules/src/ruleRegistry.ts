import type { JsonValue, WorldView } from './model/world';
import type { WorldInit } from './world/bootstrap';
import type { CommandDef } from './commands/types';
import { applyCreationInput, applyPolicyInput, applyTurnsInput } from './replayInputs';
import {
  personnelFeature,
  policyFeature,
  treatyFeature,
  treatyBreakFeature,
  treatyTradeFeature,
  fiveStatsFeature,
  operationalMapFeature,
  basicStratagemFeature,
  personnelInputKinds,
  treatyInputKinds,
  treatyBreakInputKind,
} from './ruleFeatures';
import { checkStatProfile } from './general/fiveStats';
import { checkOperationalProfile } from './world/map/profile';
import type { RecordedInput, ReplayState } from './replay';
import { campaignFeature, campaignInputKinds } from './campaign/feature';
import { campaignAssignmentFeature } from './campaign/assignment';
import { ADMIN_CLOCK_KINDS, applyAdminClockRecord } from './clock/admin';
import { ADMIN_END_KIND, applyAdminEndRecord } from './clock/end';

export interface ReplayOriginV1 {
  version: 1;
  initial: WorldInit;
  initialStateHash: string;
  resourceHash: string;
}
export interface ReplayOriginV3 {
  version: 3;
  initial: WorldInit;
  initialStateHash: string;
  resourceHash: string;
  featureData?: Record<string, JsonValue>;
}
export interface RuleFeatureDefinition {
  key: string;
  requires: readonly string[];
  conflicts: readonly string[];
  commandBindings?: readonly { definition: CommandDef; sliceKeys: readonly string[] }[];
  checkOrigin?(context: { initial: WorldInit; data: JsonValue | undefined }): void;
  checkArchive?(context: {
    origin: ReplayOriginV3;
    inputs: readonly RecordedInput[];
    end?: { sequence: number; tick: number } | null;
  }): void;
  initReplayState?(replay: ReplayState, context: { initial: WorldInit; data: JsonValue | undefined }): ReplayState;
  afterAppliedInput?(before: ReplayState, after: ReplayState, input: RecordedInput): ReplayState;
  settleMonthly?(context: { before: ReplayState; settled: ReplayState; tick: number }): {
    replay: ReplayState;
    effects: unknown;
  };
}
export interface InputKindDefinition {
  kind: string;
  feature: string | null;
  route: 'direct' | 'queued';
  directTick?: boolean;
  apply(replay: ReplayState, input: RecordedInput): ReplayState;
}
export interface RuleRegistry {
  features: readonly RuleFeatureDefinition[];
  inputKinds: readonly InputKindDefinition[];
  monthlyOrder?: readonly string[];
}
export const ruleRegistry: RuleRegistry = {
  features: [
    personnelFeature,
    policyFeature,
    treatyFeature,
    treatyBreakFeature,
    treatyTradeFeature,
    fiveStatsFeature,
    operationalMapFeature,
    basicStratagemFeature,
    campaignFeature,
    campaignAssignmentFeature,
  ],
  monthlyOrder: ['treaty', 'personnel', 'campaign-assignment-v2'],
  inputKinds: [
    ...ADMIN_CLOCK_KINDS.map((kind) => ({
      kind,
      feature: null,
      route: 'direct' as const,
      directTick: true,
      apply: applyAdminClockRecord,
    })),
    { kind: ADMIN_END_KIND, feature: null, route: 'direct', directTick: true, apply: applyAdminEndRecord },
    { kind: 'turns.set', feature: null, route: 'direct', apply: applyTurnsInput },
    { kind: 'general.create', feature: null, route: 'queued', apply: applyCreationInput },
    { kind: 'general.setPolicy', feature: 'policy', route: 'queued', apply: applyPolicyInput },
    { kind: 'general.active', feature: 'policy', route: 'queued', apply: applyPolicyInput },
    ...personnelInputKinds,
    ...treatyInputKinds,
    treatyBreakInputKind,
    ...campaignInputKinds,
  ],
};

export function settleMonthlyFeatures(
  before: ReplayState,
  settled: ReplayState,
  tick: number,
  registry: RuleRegistry = ruleRegistry,
): { replay: ReplayState; effects: Record<string, unknown> } {
  let replay = settled;
  const effects: Record<string, unknown> = {};
  const selected = registry.features.filter(
    (feature) => hasRuleFeature(before.state, feature.key) && feature.settleMonthly,
  );
  const order = registry.monthlyOrder ?? [];
  if (new Set(order).size !== order.length || selected.some((feature) => !order.includes(feature.key)))
    throw new Error('월간 규칙 기능의 실행 순서가 없습니다.');
  for (const key of order) {
    const feature = selected.find((feature) => feature.key === key);
    if (!feature) continue;
    const result = feature.settleMonthly!({ before, settled: replay, tick });
    replay = result.replay;
    effects[key] = result.effects;
  }
  return { replay, effects };
}

export function checkRuleFeatures(value: unknown, registry: RuleRegistry = ruleRegistry): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (key, index) =>
        typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(key) || (index > 0 && value[index - 1] >= key),
    )
  )
    throw new Error('규칙 기능 목록은 비지 않은 오름차순 배열이어야 합니다.');
  for (const key of value) {
    const feature = registry.features.find((feature) => feature.key === key);
    if (!feature) throw new Error(`모르는 규칙 기능입니다: ${key}`);
    if (feature.requires.some((key) => !value.includes(key)) || feature.conflicts.some((key) => value.includes(key)))
      throw new Error(`규칙 기능의 의존·충돌을 확인하세요: ${key}`);
  }
  return [...value];
}
export function hasRuleFeature(state: Pick<WorldView, 'ruleFeatures'>, key: string): boolean {
  return state.ruleFeatures?.includes(key) ?? false;
}

// 해시 검사는 운반 경로에서 하고 여기서는 생성 기록의 모양과 기능을 검사한다.
export function checkReplayOrigin(
  value: unknown,
  registry: RuleRegistry = ruleRegistry,
): asserts value is ReplayOriginV3 | ReplayOriginV1 {
  const origin = value as ReplayOriginV3 | ReplayOriginV1;
  if (!origin || ![1, 3].includes(origin.version) || !origin.initial || typeof origin.initial !== 'object')
    throw new Error('재생 생성 기록의 버전을 확인하세요.');
  checkStatProfile(origin.initial);
  checkOperationalProfile(origin.initial);
  if (origin.version === 1) {
    if (Object.hasOwn(origin.initial, 'ruleFeatures') || Object.hasOwn(origin, 'featureData'))
      throw new Error('형식 1 생성 기록에 규칙 기능을 넣을 수 없습니다.');
    return;
  }
  const required = ['version', 'initial', 'initialStateHash', 'resourceHash'];
  if (
    required.some((key) => !Object.hasOwn(origin, key)) ||
    Object.keys(origin).some((key) => ![...required, 'featureData'].includes(key))
  )
    throw new Error('형식 3 생성 기록의 칸을 확인하세요.');
  const features = Object.hasOwn(origin.initial, 'ruleFeatures')
    ? checkRuleFeatures(origin.initial.ruleFeatures, registry)
    : [];
  if (
    Object.hasOwn(origin, 'featureData') &&
    (!origin.featureData ||
      typeof origin.featureData !== 'object' ||
      Array.isArray(origin.featureData) ||
      Object.keys(origin.featureData).length === 0 ||
      Object.keys(origin.featureData).some((key) => !features.includes(key)))
  )
    throw new Error('규칙 기능 자료의 키를 확인하세요.');
  for (const key of features)
    registry.features
      .find((feature) => feature.key === key)!
      .checkOrigin?.({ initial: origin.initial, data: origin.featureData?.[key] });
}
