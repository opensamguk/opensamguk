import type { Prisma } from '@opensamguk/db';
import {
  checkReplayOrigin,
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
export function checkStoredReplayFormat(world: Pick<EngineWorld, 'replayFormat' | 'replayOrigin'>) {
  return checkWorldReplay(world);
}
export function checkWorldReplay(
  world: Pick<EngineWorld, 'replayFormat' | 'replayOrigin'>,
  registry: RuleRegistry = ruleRegistry,
) {
  const origin: unknown = world.replayOrigin;
  checkReplayOrigin(origin, registry);
  if (origin.version !== world.replayFormat) throw new Error('월드 재생 형식이 생성 기록과 다릅니다.');
  return origin;
}
