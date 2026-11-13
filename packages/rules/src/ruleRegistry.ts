import { BATTLE_TACTICS_FEATURE } from './battle/tactics';
import { WAR_INCOME_FEATURE } from './monthly/warIncome';
import { CITY_CONFLICT_AWARD_FEATURE, CITY_CONFLICT_FEATURE } from './battle/cityConflict';
import { MILITARY_STAT_GROWTH_FEATURE, STAT_GROWTH_FEATURE } from './general/statGrowth';
import {
  applyFinanceRates,
  NATION_FINANCE_FEATURE,
  NATION_FINANCE_KIND,
  RANKED_PAYROLL_FEATURE,
  WALL_INCOME_FEATURE,
} from './personnel/financeRates';
import { applyHeritagePurchase, HERITAGE_BENEFIT_KIND, HERITAGE_BENEFITS_FEATURE } from './heritage/benefits';
import { applyDefenseStance, DEFENSE_STANCE_FEATURE, DEFENSE_STANCE_KIND } from './battle/defenders';
import { NPC_NATION_POLICY_FEATURE, NPC_NATION_POLICY_KIND, applyNpcNationPolicy } from './npc/policy';
import {
  NATION_RESTRICTIONS_FEATURE,
  NATION_RESTRICTIONS_KIND,
  applyNationRestrictions,
} from './personnel/nationRestrictions';
import { inactiveRemovalFeature, INACTIVE_REMOVAL_FEATURE } from './policy/inactiveRemoval';
import { GENERAL_PROFICIENCY_FEATURE } from './general/proficiency';
import { convertProficiency } from './commands/convertProficiency';
import { COMBAT_SPECIALTY_FEATURE } from './general/combatSpecialty';
import { DOMESTIC_SPECIALTY_FEATURE } from './general/domesticSpecialty';
import { GENERAL_PERSONALITY_FEATURE } from './general/personality';
import { RESEARCH_ERA_FEATURE } from './nationResearch/era';
import { NATION_PHILOSOPHY_FEATURE } from './personnel/nationPhilosophy';
import { COURT_ABILITY_FEATURE, COURT_PROMOTION_FEATURE, COURT_RANK_FEATURE } from './personnel/nationRank';
import type { JsonValue, WorldView } from './model/world';
import type { WorldInit } from './world/bootstrap';
import { checkInitialNpcStatLimits } from './world/initialNpcStats';
import { assertInitialNationLifecycle, NATION_LIFECYCLE_FEATURE } from './nationLifecycle/state';
import type { CommandDef } from './commands/types';
import type { CommandResolver } from './commands/resolve';
import { applyCreationInput, applyPolicyInput, applyTurnsInput } from './replayInputs';
import { POSSESSION_KIND, applyPossessionInput } from './entry/possess';
import {
  personnelFeature,
  policyFeature,
  treatyFeature,
  treatyBreakFeature,
  treatyTradeFeature,
  treatyExpandedFeature,
  fiveStatsFeature,
  operationalMapFeature,
  basicStratagemFeature,
  battleAffinityFeature,
  personnelInputKinds,
  treatyInputKinds,
  treatyBreakInputKind,
} from './ruleFeatures';
import { checkStatProfile } from './general/fiveStats';
import { GENERAL_CONDITION_FEATURE } from './general/condition';
import { RICE_MARKET_FEATURE } from './world/riceMarket';
import { RANKED_AID_FEATURE } from './diplomacy/treaty';
import { DIPLOMATIC_COOLDOWN_FEATURE } from './diplomacy/cooldown';
import { PLAYER_AUTOPLAY_FEATURE } from './policy';
import { CITY_SEASONAL_EVENTS_FEATURE } from './monthly/citySeasonalEvents';
import { EXPANDED_TREATY_FEATURE } from './diplomacy/treatyClauses';
import { checkOperationalProfile } from './world/map/profile';
import type { RecordedInput, ReplayState } from './replay';
import { campaignFeature, campaignInputKinds } from './campaign/feature';
import { campaignAssignmentFeature } from './campaign/assignment';
import { ADMIN_CLOCK_KINDS, applyAdminClockRecord } from './clock/admin';
import { cityResourcesFeature, cityResourceInputKind } from './cityResourcesFeature';
import { ADMIN_END_KIND, applyAdminEndRecord } from './clock/end';
import { ADMIN_RESET_KIND, applyAdminResetRecord } from './clock/reset';
import { logisticsFeature, logisticsInputKind } from './logistics/feature';
import { equipmentFeature } from './equipment/feature';
import { governanceFeature, governanceInputKind } from './governance/feature';
import { lineageFeature, lineageInputKind } from './lineage/feature';
import { stratagemCardsFeature, stratagemCardsInputKind } from './stratagemCards/feature';
import { heritageFeature } from './heritage/feature';
import { ADMIN_GAME_KINDS } from './admin/game';
import { applyAdminGameRecord } from './admin/apply';
import { ADMIN_SETTING_KINDS, applyAdminSettingRecord } from './admin/settings';
import type { UnitSetResource } from './world/resources';
import { CITY_OFFICE_VOLUNTEER_FEATURE, initialCityOfficeVolunteers } from './personnel/cityOfficeVolunteers';
import { OFFICE_EFFECTS_FEATURE, officeEffectsSchema } from './personnel/residentOffice';
import { reputationFeature } from './review/feature';
import { cityScaleFeature } from './cityScale/feature';
import { checkCityScaleInitial } from './cityScale/state';
import { nationStrategyFeature } from './nationStrategy/feature';
import { nationLifecycleFeature } from './nationLifecycle/feature';
import { preparedTurnsFeature } from './preparedTurns/feature';
import { nationResearchFeature } from './nationResearch/feature';
import { relationsFeature } from './relations/data';
import { cleanTroops, gatherBinding, TROOP_FEATURE } from './commands/ext/troop/state';
import { TROOP_ACTION_KIND } from './commands/ext/troop/actions';
import { applyTroopInput } from './commands/ext/troop/replay';
import { troopExpel } from './commands/ext/troop/expel';
import { troopGather } from './commands/ext/troop/gather';
import { INTEL_FEATURE, spyBinding } from './commands/ext/intel/record';
import { spy } from './commands/ext/intel/spy';
import { returnBorder } from './commands/ext/return_border/return_border';

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
export function replayResourceHashInput(initial: WorldInit, featureData?: ReplayOriginV3['featureData']) {
  return {
    scenarioKey: initial.scenarioKey,
    mapKey: initial.mapKey,
    unitSetKey: initial.unitSetKey,
    statRules: initial.statRules,
    unitSet: initial.unitSet,
    ...(initial.operationalMap ? { operationalMap: initial.operationalMap } : {}),
    ...(featureData === undefined ? {} : { featureData }),
  };
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
  afterAppliedInput?(
    before: ReplayState,
    after: ReplayState,
    input: RecordedInput,
    context?: { route: InputKindDefinition['route'] },
  ): ReplayState;
  settleMonthly?(context: { before: ReplayState; settled: ReplayState; tick: number; seed?: string }): {
    replay: ReplayState;
    effects: unknown;
  };
}
export interface InputKindDefinition {
  kind: string;
  feature: string | null;
  route: 'direct' | 'queued';
  directTick?: boolean;
  apply(
    replay: ReplayState,
    input: RecordedInput,
    context?: { resolver?: CommandResolver | undefined; unitSet?: UnitSetResource },
  ): ReplayState;
}
export interface RuleRegistry {
  features: readonly RuleFeatureDefinition[];
  inputKinds: readonly InputKindDefinition[];
  monthlyOrder?: readonly string[];
}
export const ruleRegistry: RuleRegistry = {
  features: [
    { key: BATTLE_TACTICS_FEATURE, requires: ['combat-specialty-v1'], conflicts: [] },
    { key: HERITAGE_BENEFITS_FEATURE, requires: ['heritage-v1'], conflicts: [] },
    preparedTurnsFeature,
    nationResearchFeature,
    relationsFeature,
    personnelFeature,
    {
      key: COURT_RANK_FEATURE,
      requires: ['personnel'],
      conflicts: [],
      checkOrigin({ initial, data }) {
        if (
          data !== undefined ||
          initial.nations.some((nation) => !Number.isInteger(nation.level) || nation.level < 0 || nation.level > 7)
        )
          throw new Error('작위별 관직의 시작 작위를 확인하세요.');
      },
    },
    {
      key: OFFICE_EFFECTS_FEATURE,
      requires: ['personnel'],
      conflicts: [],
      checkOrigin({ data }) {
        officeEffectsSchema.parse(data);
      },
      initReplayState(replay, { data }) {
        return { ...replay, state: { ...replay.state, officeEffects: officeEffectsSchema.parse(data) } };
      },
    },
    {
      key: CITY_OFFICE_VOLUNTEER_FEATURE,
      requires: [OFFICE_EFFECTS_FEATURE],
      conflicts: [],
      checkOrigin({ initial, data }) {
        if (data !== undefined || Object.hasOwn(initial, 'cityOfficeVolunteers'))
          throw new Error('도시 관직 자원은 빈 상태에서 시작합니다.');
      },
      initReplayState(replay) {
        return { ...replay, state: { ...replay.state, cityOfficeVolunteers: initialCityOfficeVolunteers() } };
      },
    },
    policyFeature,
    inactiveRemovalFeature,
    { key: NATION_RESTRICTIONS_FEATURE, requires: [], conflicts: [] },
    { key: NPC_NATION_POLICY_FEATURE, requires: [], conflicts: [] },
    { key: NATION_FINANCE_FEATURE, requires: [], conflicts: [] },
    { key: RANKED_PAYROLL_FEATURE, requires: [NATION_FINANCE_FEATURE], conflicts: [] },
    { key: WALL_INCOME_FEATURE, requires: [], conflicts: [] },
    { key: WAR_INCOME_FEATURE, requires: [], conflicts: [] },
    { key: CITY_CONFLICT_FEATURE, requires: [], conflicts: [] },
    { key: CITY_CONFLICT_AWARD_FEATURE, requires: [CITY_CONFLICT_FEATURE], conflicts: [] },
    { key: STAT_GROWTH_FEATURE, requires: [], conflicts: [] },
    { key: MILITARY_STAT_GROWTH_FEATURE, requires: [STAT_GROWTH_FEATURE], conflicts: [] },
    { key: DEFENSE_STANCE_FEATURE, requires: [], conflicts: [] },
    { key: PLAYER_AUTOPLAY_FEATURE, requires: ['policy'], conflicts: [] },
    { key: CITY_SEASONAL_EVENTS_FEATURE, requires: [], conflicts: [] },
    { key: NATION_PHILOSOPHY_FEATURE, requires: [], conflicts: [] },
    { key: RESEARCH_ERA_FEATURE, requires: [], conflicts: [] },
    { key: COURT_PROMOTION_FEATURE, requires: [COURT_RANK_FEATURE], conflicts: [] },
    { key: COURT_ABILITY_FEATURE, requires: [COURT_RANK_FEATURE], conflicts: [] },
    treatyFeature,
    treatyBreakFeature,
    treatyTradeFeature,
    treatyExpandedFeature,
    { key: RANKED_AID_FEATURE, requires: [EXPANDED_TREATY_FEATURE], conflicts: [] },
    { key: DIPLOMATIC_COOLDOWN_FEATURE, requires: [RANKED_AID_FEATURE], conflicts: [] },
    fiveStatsFeature,
    {
      key: GENERAL_PROFICIENCY_FEATURE,
      requires: [],
      conflicts: [],
      commandBindings: [{ definition: convertProficiency, sliceKeys: [] }],
    },
    { key: COMBAT_SPECIALTY_FEATURE, requires: [], conflicts: [] },
    { key: DOMESTIC_SPECIALTY_FEATURE, requires: [], conflicts: [] },
    { key: GENERAL_PERSONALITY_FEATURE, requires: [], conflicts: [] },
    { key: GENERAL_CONDITION_FEATURE, requires: ['five-stats'], conflicts: [] },
    { key: RICE_MARKET_FEATURE, requires: [], conflicts: [] },
    operationalMapFeature,
    basicStratagemFeature,
    battleAffinityFeature,
    campaignFeature,
    campaignAssignmentFeature,
    cityResourcesFeature,
    logisticsFeature,
    equipmentFeature,
    governanceFeature,
    lineageFeature,
    heritageFeature,
    stratagemCardsFeature,
    reputationFeature,
    cityScaleFeature,
    nationStrategyFeature,
    nationLifecycleFeature,
    {
      key: 'border-return-v1',
      requires: [NATION_LIFECYCLE_FEATURE],
      conflicts: [],
      commandBindings: [{ definition: returnBorder, sliceKeys: [] }],
    },
    {
      key: TROOP_FEATURE,
      requires: ['policy'],
      conflicts: [],
      commandBindings: [
        { definition: troopGather, sliceKeys: gatherBinding.sliceKeys },
        { definition: troopExpel, sliceKeys: gatherBinding.sliceKeys },
      ],
      checkOrigin({ initial, data }) {
        if (Object.hasOwn(initial, 'ext') || data !== undefined) throw new Error('부대는 빈 상태에서 시작합니다.');
      },
      initReplayState(replay) {
        return { ...replay, state: { ...replay.state, ext: { ...replay.state.ext, troop: { troops: {} } } } };
      },
      settleMonthly({ settled }) {
        cleanTroops(settled.state);
        return { replay: settled, effects: null };
      },
    },
    {
      key: INTEL_FEATURE,
      requires: ['policy'],
      conflicts: [],
      commandBindings: [{ definition: spy, sliceKeys: spyBinding.sliceKeys }],
      checkOrigin({ initial, data }) {
        if (Object.hasOwn(initial, 'ext') || data !== undefined) throw new Error('첩보는 빈 기록에서 시작합니다.');
      },
      initReplayState(replay) {
        return { ...replay, state: { ...replay.state, ext: { ...replay.state.ext, intel: {} } } };
      },
    },
  ],
  monthlyOrder: [
    INACTIVE_REMOVAL_FEATURE,
    'treaty',
    'lineage-v1',
    'nation-lifecycle-v1',
    'personnel',
    'campaign-assignment-v2',
    'logistics-v1',
    'governance-v1',
    'stratagem-cards-v1',
    'reputation-v1',
    'city-scale-v1',
    TROOP_FEATURE,
  ],
  inputKinds: [
    { kind: HERITAGE_BENEFIT_KIND, feature: HERITAGE_BENEFITS_FEATURE, route: 'queued', apply: applyHeritagePurchase },
    { kind: TROOP_ACTION_KIND, feature: TROOP_FEATURE, route: 'queued', apply: applyTroopInput },
    ...ADMIN_SETTING_KINDS.map((kind) => ({
      kind,
      feature: null,
      route: 'direct' as const,
      directTick: true,
      apply: applyAdminSettingRecord,
    })),
    ...ADMIN_GAME_KINDS.map((kind) => ({
      kind,
      feature: null,
      route: 'direct' as const,
      directTick: true,
      apply: applyAdminGameRecord,
    })),
    ...ADMIN_CLOCK_KINDS.map((kind) => ({
      kind,
      feature: null,
      route: 'direct' as const,
      directTick: true,
      apply: applyAdminClockRecord,
    })),
    { kind: ADMIN_END_KIND, feature: null, route: 'direct', directTick: true, apply: applyAdminEndRecord },
    { kind: ADMIN_RESET_KIND, feature: null, route: 'direct', directTick: true, apply: applyAdminResetRecord },
    { kind: 'turns.set', feature: null, route: 'direct', apply: applyTurnsInput },
    { kind: 'general.create', feature: null, route: 'queued', apply: applyCreationInput },
    { kind: POSSESSION_KIND, feature: null, route: 'queued', apply: applyPossessionInput },
    {
      kind: NATION_RESTRICTIONS_KIND,
      feature: NATION_RESTRICTIONS_FEATURE,
      route: 'queued',
      apply: applyNationRestrictions,
    },
    { kind: NPC_NATION_POLICY_KIND, feature: NPC_NATION_POLICY_FEATURE, route: 'queued', apply: applyNpcNationPolicy },
    { kind: NATION_FINANCE_KIND, feature: NATION_FINANCE_FEATURE, route: 'queued', apply: applyFinanceRates },
    { kind: DEFENSE_STANCE_KIND, feature: DEFENSE_STANCE_FEATURE, route: 'queued', apply: applyDefenseStance },
    { kind: 'general.setPolicy', feature: 'policy', route: 'queued', apply: applyPolicyInput },
    { kind: 'general.active', feature: 'policy', route: 'queued', apply: applyPolicyInput },
    ...personnelInputKinds,
    ...treatyInputKinds,
    treatyBreakInputKind,
    ...campaignInputKinds,
    cityResourceInputKind,
    logisticsInputKind,
    governanceInputKind,
    lineageInputKind,
    stratagemCardsInputKind,
  ],
};

export function settleMonthlyFeatures(
  before: ReplayState,
  settled: ReplayState,
  tick: number,
  registry: RuleRegistry = ruleRegistry,
  seed?: string,
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
    const result = feature.settleMonthly!({ before, settled: replay, tick, ...(seed === undefined ? {} : { seed }) });
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
  if (
    Object.hasOwn(origin.initial, 'recruitmentLocation') &&
    (origin.version !== 3 || origin.initial.recruitmentLocation !== 'city')
  )
    throw new Error('재생 생성 기록의 모집 위치를 확인하세요.');
  if (origin.initial.generals.some((general) => Object.hasOwn(general, 'officerCityKey')))
    throw new Error('초기 장수에는 도시 관직을 배정할 수 없습니다.');
  if (origin.initial.generals.some((general) => Object.hasOwn(general, 'defenseThreshold')))
    throw new Error('초기 장수에는 개별 수비 기준을 지정할 수 없습니다.');
  if (origin.initial.generals.some((general) => Object.hasOwn(general, 'proficiency')))
    throw new Error('초기 장수의 숙련도는 기본값에서 시작합니다.');
  if (origin.initial.nations.some((nation) => Object.hasOwn(nation, 'npcSettings')))
    throw new Error('초기 국가에는 개별 NPC 운영 기준을 지정할 수 없습니다.');
  if (origin.initial.nations.some((nation) => Object.hasOwn(nation, 'restrictions')))
    throw new Error('초기 국가에는 개별 임관·출병 제한을 지정할 수 없습니다.');
  checkStatProfile(origin.initial);
  checkInitialNpcStatLimits(origin.initial, origin.version === 3 ? 'current' : 'legacy');
  checkCityScaleInitial(origin.initial);
  checkOperationalProfile(origin.initial);
  assertInitialNationLifecycle(
    origin.initial,
    origin.version === 3 && origin.initial.ruleFeatures?.includes(NATION_LIFECYCLE_FEATURE) === true,
  );
  if (origin.initial.unitSet.coefMode === 'multiply' && !origin.initial.ruleFeatures?.includes('battle-affinity-v2'))
    throw new Error('곱셈 병종 판에는 battle-affinity-v2 규칙 기능이 필요합니다.');
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
