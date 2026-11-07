// 순수 게임 규칙. DB, 네트워크, 파일, 현재 시각, Math.random을 쓰지 않는다 (lint로 막음).
export const RULESET_ID = 'opensamguk-mvp';
export * from './world/bootstrap';
export * from './world/preset';
export * from './world/options';
export * from './world/resources';
export { checkInitialNpcStatLimits, MAX_STARTING_NPC_STAT } from './world/initialNpcStats';
export { crewContext, crewTypeFailure } from './world/crewRequirements';
export { readOperationalMap, attachOperationalKinds, operationalMapDisplay } from './world/map/stored';
export { checkOperationalProfile } from './world/map/profile';
export type { OperationalMapResource } from './world/map/operational';
export * from './clock/constants';
export * from './clock/clock';
export * from './clock/admin';
export * from './admin/game';
export * from './admin/apply';
export * from './admin/settings';
export * from './clock/end';
export * from './clock/reset';
export {
  toWorldState,
  type JsonValue,
  type WorldExt,
  type WorldState,
  type DeepReadonly,
  type WorldView,
} from './model/world';
export * from './balance';
export * from './commands/types';
export * from './commands/effects';
export * from './commands/registry';
export { extSliceKeys, restoreExtState } from './commands/ext/state';
export { INTEL_FEATURE, intelRecordSchema, getIntelSliceSchema } from './commands/ext/intel/record';
export * from './monthly/index';
export * from './replay';
export {
  ORIGIN_CAPS,
  ARCHIVE_CAPS,
  CAPS_INPUT_OWNERS,
  parseCapsOrigin,
  selectSupportedCapabilities,
  capsResourceHashInput,
  validateCapsRecordedInput,
  startCapsReplay,
  applyCapsRecordedInput,
  runCapsReplayAction,
  type CapabilityDescriptor,
  type CapsOrigin,
  type CapabilitySelection,
} from './replayCapabilities';
export { selectWorldCapabilities, projectTreatyRows, type WorldCapabilities } from './capsWorld';
export * from './general/create';
export * from './general/fiveStats';
export { commanderBattleModifiers, type CommanderBattleStats } from './general/fiveStatsBattle';
export * from './general/creationBlock';
export * from './supply';
export * from './commands/turn';
export * from './ranking';
export * from './npc';
export * from './advice/general';
export * from './policy';
export * from './policy/replay';
export * from './operation/calendar';
export * from './operation/timeline';
export * from './operation/forecast';
export * from './operation/suggest';
export {
  calculateTreatyFee,
  settleTreatyFees,
  meetsTreatyPeaceRequirement,
  canNpcAcceptTreaty,
  canRepresentTreatyProposal,
  TREATY_INPUTS,
  validateTreatyRecord,
  validateTreatyState,
  validateClosedTreatyRow,
  validateBrokenTreatyRow,
  validateNationTrustState,
  nextNationTrust,
  treatyBreakRecipients,
  decodeTreatyRecord,
  treatyRespondByTick,
  treatyClauseEndTick,
  type TreatyOptions,
  applyTreatyInput,
  settleTreaties,
  treatyClosures,
  quoteTreatyProposal,
  guideTreatyResponse,
  type TreatyAmounts,
  type TreatyFeeResult,
  type TreatyRelation,
  type TreatyWorldState,
  type TreatyQuoteCode,
  type TreatyQuoteResult,
  type TreatyResponseGuide,
  type TreatyResponseGuideCode,
} from './diplomacy/treaty';
export type {
  TreatyClause,
  FirstTreatyClause,
  ConnectedTreatyClause,
  TreatyState,
  ClosedTreatyRow,
  BrokenTreatyRow,
  NationTrustState,
  TreatyBroken,
  TreatyBreakRejectCode,
  TreatyInput,
  TreatyApplied,
  TreatyRejectCode,
  TreatyRejected,
  TreatyRecord,
  TreatyRecordContext,
  TreatyClosure,
  TreatyApplyResult,
} from './diplomacy/treatyTypes';
export * from './battle/simulate';
export * from './season';
export {
  officerTitle,
  canManagePersonnel,
  canUseNationTurns,
  canExecuteNationCommand,
  nationCommandKeys,
  APPOINTABLE_OFFICER_LEVELS,
  isAppointableOfficerLevel,
} from './personnel/permissions';
export {
  PERSONNEL_INPUTS,
  applyPersonnelInput,
  validatePersonnelRecord,
  replayPersonnelInput,
  finishPersonnelStep,
  applyNationTurnsRecord,
  PersonnelInvariantError,
  assignmentRejectCost,
  ASSIGNMENT_REJECT_PERCENT,
} from './personnel';
export type {
  PersonnelInputKind,
  PersonnelRecordKind,
  PersonnelRejectCode,
  PersonnelRecordedInput,
  AppliedPersonnelInput,
  NationTurnsRecord,
  PendingPersonnelEvent,
  PersonnelInputContext,
  PersonnelInputOutcome,
  PersonnelStepResult,
  PersonnelRecordContext,
  OfficeTurns,
  OfficeRevisions,
  OfficeState,
  OfficeView,
  PersonnelChange,
  ClosedOffer,
  PersonnelLog,
} from './personnel';
export * from './tournament/bracket';
export * from './tournament/match';
export {
  createCommandResolver,
  extensionCommands,
  createExtState,
  type EnabledCommands,
  type CommandResolver,
  type ExtInitContext,
  type ExtSlice,
} from './commands/resolve';
export {
  applyModifiers,
  type Modifier,
  type ModifierOp,
  type ModifierStage,
  type ModifierContext,
  type ModifierProvider,
  type BattleModifiers,
} from './modifiers';

export * from './ruleRegistry';
export { createRelationsData, RELATIONS_FEATURE } from './relations/data';
export { readStoredRelations } from './relations/origin';
export { applyPersonnelInputStep } from './personnel/inputStep';
export { completePersonnelStep } from './personnel/step';
export type { PersonnelStepPacket } from './personnel/step';
export { runPersonnelMonth } from './personnel/monthStep';
export type { PersonnelMonthResult } from './personnel/monthStep';
export { updateResidenceAnchors } from './personnel/residence';
export * from './commands/ext/intel/record';
export { trade, findTradeRoutes, type TradeRoute } from './commands/trade';
export { resolverForRuleFeatures } from './ruleCommands';

export * from './campaign/retinue';
export * from './campaign/state';
export * from './campaign/relationships';
export * from './campaign/record';
export * from './campaign/unitInputs';
export * from './campaign/orderTypes';
export * from './campaign/orders';
export { campaignArmyTypes, validateCampaignRecord } from './campaign/feature';
export { commandStatPreview, type CommandStatPreview } from './commands/statPreview';
export * from './cityResources/state';
export { initialCityRuins, readCityRuins, RUIN_PERCENT, type CityRuinsState } from './cityScale/state';
export * from './cityResources/input';
export { canExecuteCityNationCommand } from './cityResources/commands';
export * from './clock/createRequest';
export * from './logistics/state';
export * from './logistics/origin';
export * from './equipment/config';
export * from './equipment/state';
export * from './equipment/origin';
export * from './equipment/stats';
export { STANDARD_EQUIPMENT_CONFIG } from './equipment/catalog';
export * from './logistics/ledger';
export * from './logistics/consumption';
export {
  applyLogisticsInput,
  findLogisticsPath,
  logisticsInputSchema,
  settleLogisticsMonthly,
  type LogisticsInput,
} from './logistics/operations';
export { logisticsResultSchema, validateLogisticsRecord } from './logistics/feature';
export * from './governance/config';
export * from './governance/state';
export * from './governance/actions';
export * from './governance/ledger';
export * from './governance/origin';
export * from './governance/visibility';
export { reconcileGovernance, assertGovernanceFinal } from './governance/reconcile';
export * from './nationLifecycle/state';
export { settleNationLifecycleMonthly } from './nationLifecycle/monthly';
export { readStoredNationLifecycle } from './nationLifecycle/origin';
export type { NationLifecycleEffects } from './nationLifecycle/operations';
export { governanceResultSchema, validateGovernanceRecord } from './governance/feature';
export * from './general/sex';
export * from './general/removal';
export * from './lineage/config';
export * from './lineage/state';
export * from './lineage/origin';
export * from './lineage/invariants';
export * from './lineage/eligibility';
export * from './lineage/actions';
export * from './lineage/preview';
export * from './lineage/visibility';
export * from './lineage/history';
export * from './personnel/assignmentRows';
export * from './lineage/control';
export { reconcileLineage } from './lineage/reconcile';
export * from './lineage/monthly';
export { lineageResultSchema, lineageRejectionSchema, validateLineageRecord } from './lineage/feature';
export * from './heritage/constants';
export * from './heritage/allocation';
export * from './heritage/activity';
export * from './heritage/awards';
export * from './heritage/refund';
export * from './heritage/creation';
export { heritageFeatureDataSchema } from './heritage/feature';
export * from './clock/featureProfile';
export * from './entry/possess';
export * from './entry/roles';
export * from './stratagemCards/config';
export * from './world/resourceKey';
export * from './stratagemCards/state';
export * from './stratagemCards/origin';
export * from './stratagemCards/view';
export * from './stratagemCards/actions';
export * from './review/schema';
export * from './review/ledger';
export * from './review/lines';
export * from './review/settle';
export * from './review/events';
export { reputationFeature } from './review/feature';
export * from './stratagemCards/resolver';
export {
  readStratagemCardsConfig,
  stratagemCardsResultSchema,
  validateStratagemCardsRecord,
} from './stratagemCards/feature';
export {
  readNationStrategy,
  initialNationStrategy,
  NATION_STRATEGY_FEATURE,
  type NationStrategyState,
} from './nationStrategy/state';
export { readStoredNationStrategy } from './nationStrategy/origin';
export {
  readPreparedTurns,
  initialPreparedTurns,
  PREPARED_TURNS_FEATURE,
  type PreparedTurnsState,
} from './preparedTurns/state';
export { readStoredPreparedTurns } from './preparedTurns/origin';
export {
  readNationResearch,
  initialNationResearch,
  NATION_RESEARCH_FEATURE,
  type NationResearchState,
} from './nationResearch/state';
export { readStoredNationResearch } from './nationResearch/origin';
export { canExecuteResearchNationCommand } from './nationResearch/commands';
