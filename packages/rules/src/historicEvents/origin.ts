import { z } from 'zod';
import { readHistoricEventsConfig, readHistoricEventsState } from './state';

export const HISTORIC_EVENTS_FEATURE = 'historic-events';

type HistoricEventsInitial = Parameters<typeof readHistoricEventsConfig>[0] & { scenarioKey: string };

export function readHistoricEventsOriginConfig(initial: HistoricEventsInitial, data: unknown) {
  if (initial.scenarioKey !== '1030') throw new Error('역사 사건은 1030 시나리오에서만 사용할 수 있습니다.');
  return readHistoricEventsConfig(initial, data);
}

interface HistoricEventsWorldRecord {
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  monthlyTick: number;
  historicEventsState: unknown;
}

const originSchema = z.object({
  version: z.literal(3),
  initial: z.object({
    scenarioKey: z.string(),
    startYear: z.number().int(),
    nations: z.array(z.object({ id: z.number().int().positive(), name: z.string().min(1) })),
    ruleFeatures: z.array(z.string()),
  }),
  featureData: z.record(z.string(), z.unknown()),
});

export function readHistoricEventsStorage(world: HistoricEventsWorldRecord) {
  if (!world.ruleFeatures.includes(HISTORIC_EVENTS_FEATURE)) {
    if (world.historicEventsState != null) throw new Error('역사 사건 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  const { initial, featureData } = originSchema.parse(world.replayOrigin);
  if (world.replayFormat !== 3 || JSON.stringify(initial.ruleFeatures) !== JSON.stringify(world.ruleFeatures)) {
    throw new Error('역사 사건 기능이 생성 기록과 다릅니다.');
  }
  const config = readHistoricEventsOriginConfig(initial, featureData[HISTORIC_EVENTS_FEATURE]);
  return {
    config,
    state: readHistoricEventsState(world.historicEventsState, config, initial.startYear, world.monthlyTick),
  };
}
