import { z } from 'zod';
import type { WorldView } from '../model/world';
import { readStratagemCardsConfig } from './feature';
import { readStratagemCardsState, stratagemCardsStateSchema } from './state';

interface CardsWorldRecord {
  replayFormat: number;
  ruleFeatures: readonly string[];
  replayOrigin: unknown;
  monthlyTick: number;
  stratagemCardsState: unknown;
}
const originSchema = z.object({
  version: z.literal(3),
  initial: z.object({ seed: z.string().min(1), ruleFeatures: z.array(z.string()) }),
  featureData: z.record(z.string(), z.unknown()),
});

// 소유 변경 직후의 queued 정리도 설정·시드·월 시각을 먼저 검증한다.
export function readStratagemCardsStorage(world: CardsWorldRecord) {
  if (!world.ruleFeatures.includes('stratagem-cards-v1')) {
    if (world.stratagemCardsState != null) throw Error('계략 패를 끈 월드에 저장 상태가 있습니다.');
    return undefined;
  }
  const origin = originSchema.parse(world.replayOrigin);
  if (
    world.replayFormat !== 3 ||
    !world.ruleFeatures.includes('personnel') ||
    !world.ruleFeatures.includes('five-stats') ||
    !world.ruleFeatures.includes('stratagem-basic') ||
    JSON.stringify(world.ruleFeatures) !== JSON.stringify(origin.initial.ruleFeatures)
  )
    throw Error('계략 패 기능이 원생성과 다릅니다.');
  const config = readStratagemCardsConfig(origin.featureData['stratagem-cards-v1']),
    stored = stratagemCardsStateSchema.parse(world.stratagemCardsState);
  if (JSON.stringify(stored.config) !== JSON.stringify(config) || stored.seed !== origin.initial.seed)
    throw Error('계략 패 설정·시드가 원생성과 다릅니다.');
  if (stored.monthlyTick !== world.monthlyTick) throw Error('계략 패와 월드의 월 정산 tick이 다릅니다.');
  return stored;
}

export function readStoredStratagemCards(world: CardsWorldRecord, state: WorldView) {
  const stored = readStratagemCardsStorage(world);
  return stored ? readStratagemCardsState(stored, state) : undefined;
}
