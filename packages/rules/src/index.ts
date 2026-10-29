// 순수 게임 규칙. DB, 네트워크, 파일, 현재 시각, Math.random을 쓰지 않는다 (lint로 막음).
export const RULESET_ID = 'opensamguk-mvp';
export * from './world/bootstrap';
export * from './world/preset';
export * from './world/resources';
export { readOperationalMap, attachOperationalKinds, operationalMapDisplay } from './world/map/stored';
export { checkOperationalProfile } from './world/map/profile';
export type { OperationalMapResource } from './world/map/operational';
export * from './clock/constants';
export * from './clock/clock';
export * from './clock/admin';
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
export { campaignArmyTypes, validateCampaignRecord } from './campaign/feature';
export { commandStatPreview, type CommandStatPreview } from './commands/statPreview';
export * from './cityResources/state';
