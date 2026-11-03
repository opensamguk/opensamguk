import { z } from 'zod';
import type { WorldView } from '../model/world';
import { lineageConfigSchema } from './config';
import { readLineageState } from './state';
import { assertLineageStorage } from './invariants';
import { statRulesSchema, unitSetSchema } from '../world/resources';

interface LineageWorldRecord {
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  monthlyTick: number;
  lineageState: unknown;
}
const originSchema = z.object({
  version: z.literal(3),
  initial: z.object({
    seed: z.string().min(1),
    ruleFeatures: z.array(z.string()),
    statRules: z.unknown(),
    unitSet: z.unknown(),
  }),
  featureData: z.record(z.string(), z.unknown()),
});

export function readLineageResources(world: Pick<LineageWorldRecord, 'replayOrigin'>) {
  const { initial } = originSchema.parse(world.replayOrigin);
  return {
    statRules: statRulesSchema.parse({ stat: initial.statRules }).stat,
    unitSet: { defaultCrewTypeId: unitSetSchema.parse(initial.unitSet).defaultCrewTypeId },
  };
}

export function readStoredLineage(world: LineageWorldRecord, state: WorldView) {
  if (!world.ruleFeatures.includes('lineage-v1')) {
    if (world.lineageState != null) throw Error('가문 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  const origin = originSchema.parse(world.replayOrigin);
  if (
    world.replayFormat !== 3 ||
    !world.ruleFeatures.includes('personnel') ||
    JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures)
  )
    throw Error('가문의 규칙 기능이 원생성과 다릅니다.');
  const config = lineageConfigSchema.parse(origin.featureData['lineage-v1']),
    stored = readLineageState(world.lineageState);
  if (JSON.stringify(stored.config) !== JSON.stringify(config) || stored.seed !== origin.initial.seed)
    throw Error('가문 설정·시드가 원생성과 다릅니다.');
  if (stored.monthlyTick !== world.monthlyTick) throw Error('가문과 월드의 월 정산 tick이 다릅니다.');
  assertLineageStorage({ ...state, lineage: stored });
  return stored;
}
