import type { WorldInit } from './bootstrap';
import { parseResourceKey } from './resourceKey';

const defaultMax = 100;
const originalNpcMaxByScenario: ReadonlyMap<string, number> = new Map([
  ['2121', 108],
  ['2210', 140],
  ['2200', 115],
  ['2300', 120],
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
