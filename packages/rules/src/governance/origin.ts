import { z } from 'zod';
import type { WorldView } from '../model/world';
import { readGovernanceConfig } from './config';
import { readGovernanceState } from './state';

interface GovernanceWorldRecord {
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  monthlyTick: number;
  governanceState: unknown;
}
const originSchema = z.object({
  version: z.literal(3),
  initial: z.object({ ruleFeatures: z.array(z.string()) }),
  featureData: z.record(z.string(), z.unknown()),
});

export function readStoredGovernance(world: GovernanceWorldRecord, state: Pick<WorldView, 'cities'>) {
  if (!world.ruleFeatures.includes('governance-v1')) {
    if (world.governanceState !== null && world.governanceState !== undefined)
      throw new Error('황실 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  const origin = originSchema.parse(world.replayOrigin);
  if (!['city-resources-v1', 'personnel', 'treaty'].every((key) => world.ruleFeatures.includes(key)))
    throw new Error('황실의 의존 기능이 없습니다.');
  if (world.replayFormat !== 3 || JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures))
    throw new Error('황실의 규칙 기능이 원생성과 다릅니다.');
  const config = readGovernanceConfig(origin.featureData['governance-v1'], state);
  const stored = readGovernanceState(world.governanceState);
  readGovernanceConfig(stored.config, state);
  if (JSON.stringify(stored.config) !== JSON.stringify(config)) throw new Error('황실 설정이 원생성과 다릅니다.');
  if (stored.monthlyTick !== world.monthlyTick) throw new Error('황실과 월드의 월 정산 tick이 다릅니다.');
  return stored;
}
