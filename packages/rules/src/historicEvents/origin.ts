import type { ReplayOriginV1, ReplayOriginV3 } from '../ruleRegistry';
import { checkOriginHashes } from '../world/originHashes';
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
  initialStateHash: string;
  monthlyTick: number;
  historicEventsState: unknown;
}

export function readHistoricEventsStorage(
  world: HistoricEventsWorldRecord,
  checkOrigin: (value: unknown) => asserts value is ReplayOriginV1 | ReplayOriginV3,
  hash: (value: unknown) => string,
) {
  if (!world.ruleFeatures.includes(HISTORIC_EVENTS_FEATURE)) {
    if (world.historicEventsState != null) throw new Error('역사 사건 기능을 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  const origin = world.replayOrigin;
  checkOrigin(origin);
  if (
    world.replayFormat !== 3 ||
    origin.version !== 3 ||
    JSON.stringify(origin.initial.ruleFeatures) !== JSON.stringify(world.ruleFeatures)
  ) {
    throw new Error('역사 사건 기능이 생성 기록과 다릅니다.');
  }
  if (world.initialStateHash !== origin.initialStateHash) throw new Error('월드와 원생성 상태 해시가 다릅니다.');
  checkOriginHashes(origin, hash);
  const { initial, featureData } = origin;
  const config = readHistoricEventsOriginConfig(initial, featureData?.[HISTORIC_EVENTS_FEATURE]);
  return {
    config,
    state: readHistoricEventsState(world.historicEventsState, config, initial.startYear, world.monthlyTick),
  };
}
