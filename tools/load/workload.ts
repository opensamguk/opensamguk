import { createRng } from '../../packages/shared/src/rng';
import type { LoadProcedure } from './http';

// 두 요약·두 순위의 내부 분배도 고정해 원자료의 실제 비율과 비교한다.
export const WORKLOAD_WEIGHTS = Object.freeze([
  { procedure: 'home.get', weight: 150 },
  { procedure: 'world.summary', weight: 150 },
  { procedure: 'world.map', weight: 150 },
  { procedure: 'city.get', weight: 100 },
  { procedure: 'nation.get', weight: 100 },
  { procedure: 'turns.get', weight: 100 },
  { procedure: 'turns.set', weight: 100 },
  { procedure: 'message.list', weight: 50 },
  { procedure: 'message.send', weight: 30 },
  { procedure: 'ranking.generals', weight: 25 },
  { procedure: 'ranking.nations', weight: 25 },
  { procedure: 'world.list', weight: 20 },
] satisfies Array<{ procedure: LoadProcedure; weight: number }>);

export type WorkloadProcedure = (typeof WORKLOAD_WEIGHTS)[number]['procedure'];

export function workloadChoice(fraction: number): WorkloadProcedure {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error('LOAD_RANDOM_FRACTION_INVALID');
  let remainder = fraction * 1000;
  for (const entry of WORKLOAD_WEIGHTS) {
    if (remainder < entry.weight) return entry.procedure;
    remainder -= entry.weight;
  }
  throw new Error('LOAD_WORKLOAD_WEIGHTS_INVALID');
}

export function userWorkload(seed: string, worldIndex: number, userIndex: number) {
  const rng = createRng(JSON.stringify(['load-workload-v1', seed, worldIndex, userIndex]));
  return {
    next: () => ({ procedure: workloadChoice(rng.next()), thinkMs: rng.int(1000, 3000) }),
  };
}
