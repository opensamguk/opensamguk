import type { JsonValue, WorldView } from './model/world';
import type { WorldInit } from './world/bootstrap';
import { applyCreationInput, applyTurnsInput, type RecordedInput, type ReplayState } from './replay';

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
  checkOrigin?(context: { initial: WorldInit; data: JsonValue | undefined }): void;
  checkArchive?(context: { origin: ReplayOriginV3; inputs: readonly RecordedInput[] }): void;
  initReplayState?(replay: ReplayState): ReplayState;
}
export interface InputKindDefinition {
  kind: string;
  feature: string | null;
  route: 'direct' | 'queued';
  apply(replay: ReplayState, input: RecordedInput): ReplayState;
}
export interface RuleRegistry {
  features: readonly RuleFeatureDefinition[];
  inputKinds: readonly InputKindDefinition[];
}
export const ruleRegistry: RuleRegistry = {
  features: [],
  inputKinds: [
    { kind: 'turns.set', feature: null, route: 'direct', apply: applyTurnsInput },
    { kind: 'general.create', feature: null, route: 'queued', apply: applyCreationInput },
  ],
};

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
