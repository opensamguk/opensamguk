import type { Prisma } from '@opensamguk/db';
import {
  checkReplayOrigin,
  checkRuleFeatures,
  ruleRegistry,
  type RuleRegistry,
  type ReplayState,
  type WorldState,
} from '@opensamguk/rules';
import { builtInEngineFeatures } from './ruleFeatures';

export type EngineWorld = Prisma.WorldGetPayload<Record<string, never>>;
export type EngineInput = Prisma.InputEventGetPayload<Record<string, never>>;
export type QueuedInputHandler = (
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  event: EngineInput,
  context: { tick: number; sequence: number; emit?: (signal: import('@opensamguk/db').RealtimeSignal) => void },
) => Promise<{ status: 'APPLIED' | 'REJECTED'; result: Prisma.InputJsonValue; generalId?: number }>;
export interface EngineFeature {
  key: string;
  loadWorld?(tx: Prisma.TransactionClient, worldId: string, state: WorldState): Promise<WorldState>;
  loadReplayState?(tx: Prisma.TransactionClient, worldId: string, replay: ReplayState): Promise<ReplayState>;
  persistMonthly?(
    tx: Prisma.TransactionClient,
    worldId: string,
    before: ReplayState,
    next: ReplayState,
    effects: unknown,
    context: { tick: number; sequence: number },
  ): Promise<void>;
  afterQueuedInput?(
    tx: Prisma.TransactionClient,
    world: EngineWorld,
    before: ReplayState,
    input: import('@opensamguk/rules').RecordedInput,
  ): Promise<void>;
  queuedInputs?: Record<string, QueuedInputHandler>;
}
export const engineFeatures: readonly EngineFeature[] = builtInEngineFeatures;
export interface EngineRegistry {
  rules: RuleRegistry;
  features: readonly EngineFeature[];
}
export const engineRegistry: EngineRegistry = { rules: ruleRegistry, features: engineFeatures };

// 기존 capability 형식은 DB의 기본 형식 1·빈 기능 사본을 유지한다.
export function checkStoredReplayFormat(
  world: Pick<EngineWorld, 'replayFormat' | 'ruleFeatures' | 'replayOrigin'>,
): void {
  if (world.replayFormat === 3) return checkWorldReplay(world);
  if (world.replayFormat !== 1 || !Array.isArray(world.ruleFeatures) || world.ruleFeatures.length)
    throw new Error('기존 월드의 재생 형식·기능 사본이 다릅니다.');
  const origin = world.replayOrigin;
  if (origin && typeof origin === 'object' && !Array.isArray(origin) && origin.version === 1) {
    const initial = origin.initial;
    if (
      Object.hasOwn(origin, 'featureData') ||
      (initial && typeof initial === 'object' && Object.hasOwn(initial, 'ruleFeatures'))
    )
      throw new Error('기존 생성 기록에 규칙 기능을 넣을 수 없습니다.');
  }
}

export function checkWorldReplay(
  world: Pick<EngineWorld, 'replayFormat' | 'ruleFeatures' | 'replayOrigin'>,
  registry: RuleRegistry = ruleRegistry,
): void {
  if (world.replayOrigin === null) {
    if (world.replayFormat !== 1 || world.ruleFeatures.length)
      throw new Error('생성 기록 없는 월드의 재생 사본이 다릅니다.');
    return;
  }
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin, registry);
  if (
    origin.version !== world.replayFormat ||
    (origin.version === 1 && world.ruleFeatures.length) ||
    JSON.stringify(origin.initial.ruleFeatures ?? []) !== JSON.stringify(world.ruleFeatures)
  )
    throw new Error('월드 재생 형식·기능 사본이 생성 기록과 다릅니다.');
  if (world.ruleFeatures.length) checkRuleFeatures(world.ruleFeatures, registry);
}
