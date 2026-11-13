import type { WorldView } from '../model/world';

export const NATION_PHILOSOPHY_FEATURE = 'nation-philosophy-v1';

type Domestic = 'farm' | 'commerce' | 'security' | 'settle' | 'goodwill' | 'defence' | 'wall' | 'research';
type Philosophy = {
  up?: readonly Domestic[];
  down?: readonly Domestic[];
  gold?: number;
  rice?: number;
  population?: number;
  stratagem?: number;
  delay?: readonly [number, number];
  globalDelay?: number;
};

const agriculture = ['farm', 'commerce'] as const;
const fortification = ['defence', 'wall'] as const;
const welfare = ['settle', 'goodwill'] as const;

// Effect values from core2026 c81d304, packages/logic/src/actionModules/traits/nation.
// MIT (c) 2025 devsam.
const policies: Readonly<Record<string, Philosophy>> = {
  도적: { down: ['security', ...welfare], gold: 0.9, stratagem: 0.1 },
  명가: { up: ['research'], down: fortification, rice: 0.9, population: 1.2 },
  음양가: { up: agriculture, down: ['research'], population: 1.2, delay: [4, 3] },
  종횡가: { up: fortification, down: agriculture, gold: 0.9, delay: [3, 4], globalDelay: 0.5 },
  불가: { up: [...welfare, ...fortification], gold: 0.9 },
  오두미도: { down: ['research', ...fortification, ...agriculture], rice: 1.1, population: 1.2 },
  태평도: { up: welfare, down: ['research', ...fortification], population: 1.2 },
  도가: { down: ['research', 'security'], population: 1.2 },
  묵가: { up: fortification, down: ['research'] },
  덕가: { up: ['security', ...welfare], down: fortification, rice: 0.9, population: 1.2 },
  병가: { up: ['research', ...fortification], down: welfare, population: 0.8 },
  유가: { up: [...agriculture, ...welfare], rice: 0.9 },
  법가: { up: ['security'], down: welfare, gold: 1.1, population: 0.8 },
};

export function nationPhilosophyNames() {
  return Object.keys(policies);
}

const domesticLabels: Record<Domestic, string> = {
  farm: '농업',
  commerce: '상업',
  security: '치안',
  settle: '정착',
  goodwill: '민심',
  defence: '수비',
  wall: '성벽',
  research: '기술',
};

export function nationPhilosophyEffects() {
  return Object.fromEntries(
    Object.entries(policies).map(([name, policy]) => {
      const benefits = policy.up?.map((key) => domesticLabels[key]) ?? [];
      const drawbacks = policy.down?.map((key) => domesticLabels[key]) ?? [];
      for (const [label, factor] of [
        ['금수입', policy.gold],
        ['쌀수입', policy.rice],
        ['인구 증가', policy.population],
      ] as const) {
        if (factor && factor !== 1) (factor > 1 ? benefits : drawbacks).push(label);
      }
      if (policy.stratagem) benefits.push('계략 성공률');
      if (policy.delay) (policy.delay[0] < policy.delay[1] ? benefits : drawbacks).push('전략 대기 단축');
      return [name, { benefits, drawbacks }];
    }),
  );
}

export function nationPhilosophy(
  world: Pick<WorldView, 'ruleFeatures'>,
  name: string | undefined,
): Philosophy | undefined {
  const key = name?.replace(/^che_/, '');
  if (!key || !Object.hasOwn(policies, key) || !world.ruleFeatures?.includes(NATION_PHILOSOPHY_FEATURE))
    return undefined;
  return policies[key];
}

export function philosophyDomestic(world: WorldView, nationId: number | null, commandKey: string) {
  const policy = nationPhilosophy(world, nationId === null ? undefined : world.nations[nationId]?.philosophy);
  const command = commandKey as Domestic;
  if (policy?.up?.includes(command)) return { score: 1.1, cost: 0.8 };
  if (policy?.down?.includes(command)) return { score: 0.9, cost: 1.2 };
  return { score: 1, cost: 1 };
}
