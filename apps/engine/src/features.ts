import type { Prisma } from '@opensamguk/db';
import {
  checkReplayOrigin,
  checkRuleFeatures,
  ruleRegistry,
  type RuleRegistry,
  type ReplayState,
  type WorldState,
} from '@opensamguk/rules';

export type EngineWorld = Prisma.WorldGetPayload<Record<string, never>>;
export type EngineInput = Prisma.InputEventGetPayload<Record<string, never>>;
export type QueuedInputHandler = (
  tx: Prisma.TransactionClient,
  world: EngineWorld,
  event: EngineInput,
  context: { tick: number; sequence: number },
) => Promise<{ status: 'APPLIED' | 'REJECTED'; result: Prisma.InputJsonValue; generalId?: number }>;
export interface EngineFeature {
  key: string;
  loadWorld?(tx: Prisma.TransactionClient, worldId: string, state: WorldState): Promise<WorldState>;
  loadReplayState?(tx: Prisma.TransactionClient, worldId: string, replay: ReplayState): Promise<ReplayState>;
  persistMonthly?(tx: Prisma.TransactionClient, worldId: string, before: WorldState, next: WorldState): Promise<void>;
  queuedInputs?: Record<string, QueuedInputHandler>;
}
export const engineFeatures: readonly EngineFeature[] = [];
export interface EngineRegistry {
  rules: RuleRegistry;
  features: readonly EngineFeature[];
}
export const engineRegistry: EngineRegistry = { rules: ruleRegistry, features: engineFeatures };

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
