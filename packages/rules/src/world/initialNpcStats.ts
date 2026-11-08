import type { WorldInit } from './bootstrap';
import { parseResourceKey } from './resourceKey';

const defaultMax = 100;
const originalNpcMaxByScenario: ReadonlyMap<string, number> = new Map([
  ['2090', 103],
  ['2110', 108],
  ['2120', 108],
  ['2121', 108],
  ['2130', 105],
  ['2131', 105],
  ['2140', 102],
  ['2141', 102],
  ['2150', 105],
  ['2160', 118],
  ['2171', 105],
  ['2200', 115],
  ['2210', 140],
  ['2300', 120],
  ['2600', 120],
  ['2601', 120],
  ['2700', 108],
  ['2701', 108],
  ['2702', 156],
  ['2703', 108],
  ['2704', 108],
  ['2800', 114],
  ['2801', 114],
  ['2900', 122],
  ['2901', 122],
  ['2903', 122],
  ['2904', 122],
]);
export const MAX_STARTING_NPC_STAT = Math.max(...originalNpcMaxByScenario.values());

export function startingNpcStatLimit(scenarioId: string): number {
  return originalNpcMaxByScenario.get(scenarioId) ?? defaultMax;
}

export function checkInitialNpcStatLimits(initial: Pick<WorldInit, 'scenarioKey' | 'generals'>): void {
  let scenarioId = initial.scenarioKey;
  if (scenarioId.includes('@')) {
    try {
      scenarioId = parseResourceKey(scenarioId).name;
    } catch {
      // 구형 기록의 형식이 맞지 않는 키에는 기본 상한을 쓴다.
    }
  }
  const npcMax = startingNpcStatLimit(scenarioId);
  for (const general of initial.generals) {
    const limit = general.userId === null ? npcMax : defaultMax;
    if ([general.leadership, general.strength, general.intel].some((n) => !Number.isInteger(n) || n < 0 || n > limit))
      throw new Error('시작 장수의 기본 능력치 범위를 확인하세요.');
  }
}
