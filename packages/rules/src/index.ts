// 순수 게임 규칙. DB, 네트워크, 파일, 현재 시각, Math.random을 쓰지 않는다 (lint로 막음).
export const RULESET_ID = 'opensamguk-mvp';
export * from './world/bootstrap';
export * from './world/preset';
export * from './world/resources';
export * from './clock/constants';
export * from './clock/clock';
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
  decodeTreatyRecord,
  treatyRespondByTick,
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
  TreatyState,
  ClosedTreatyRow,
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
