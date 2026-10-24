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
export * from './monthly/index';
export * from './replay';
export * from './general/create';
export * from './supply';
export * from './commands/turn';
export * from './ranking';
export * from './npc';
export * from './battle/simulate';
export * from './season';
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

export * from './ruleRegistry';
