import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import { commandRegistry } from '../commands/registry';
import { DOMESTIC_SPECS } from '../commands/domestic/investment';
import { relation } from '../commands/support';
import type { Actor } from '../commands/types';
import type { DeepReadonly, WorldView } from '../model/world';
import type { InitialGeneral } from '../world/bootstrap';

export interface NpcCandidate {
  key: string;
  args: Record<string, unknown>;
  score: number;
  reason: string;
}
export interface NpcDecision {
  chosen: NpcCandidate | null;
  candidates: NpcCandidate[];
}
export interface NpcContext {
  tick?: number;
  unitSet?: Actor['unitSet'];
  convergence?: boolean;
}
type General = DeepReadonly<InitialGeneral>;

function chooser(view: WorldView, general: General, rng: Rng, context: NpcContext, target: 'general' | 'nation') {
  const candidates: NpcCandidate[] = [];
  const actor: Actor = { generalId: general.id, tick: context.tick ?? 0, unitSet: context.unitSet, target };
  return {
    add(key: string, args: Record<string, unknown>, score: number, reason: string) {
      const command = commandRegistry.get(key);
      const parsed = command?.args.safeParse(args);
      if (command?.target === target && parsed?.success && !command.check(view, actor, parsed.data)) {
        candidates.push({ key, args, score, reason });
      }
    },
    finish(): NpcDecision {
      candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key) || JSON.stringify(a.args).localeCompare(JSON.stringify(b.args)));
      return { chosen: candidates.length ? rng.pick(candidates.filter((c) => c.score === candidates[0]!.score)) : null, candidates };
    },
  };
}

function frontier(view: WorldView, nationId: number, cityKey: number) {
  return view.cities[cityKey]!.connections.some((key) => view.cities[key]?.nationId !== nationId);
}

// 자기 영토의 BFS로 전선까지 한 칸을 고른다. ID 순서로 동률을 고정한다.
function frontlineSteps(view: WorldView, general: General): number[] {
  const start = view.cities[general.cityKey]!;
  const queue = start.connections.filter((key) => view.cities[key]?.nationId === general.nationId).sort((a, b) => a - b).map((key) => ({ key, first: key, distance: 1 }));
  const seen = new Set([start.cityKey]);
  let distance = Infinity;
  const steps = new Set<number>();
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]!;
    if (item.distance > distance || seen.has(item.key)) continue;
    seen.add(item.key);
    if (frontier(view, general.nationId!, item.key)) {
      distance = item.distance;
      steps.add(item.first);
      continue;
    }
    for (const key of view.cities[item.key]!.connections) {
      if (!seen.has(key) && view.cities[key]?.nationId === general.nationId) queue.push({ key, first: item.first, distance: item.distance + 1 });
    }
  }
  return [...steps].sort((a, b) => a - b);
}

export function chooseGeneralTurn(view: WorldView, general: General, rng: Rng, context: NpcContext = {}): NpcDecision {
  if (general.userId !== null) return { chosen: null, candidates: [] };
  const choice = chooser(view, general, rng, context, 'general');
  choice.add('rest', {}, 0, '실행할 명령이 없으면 쉰다.');
  if (general.nationId === null) {
    for (const nation of Object.values(view.nations)) choice.add('join', { nationId: nation.id }, 100, '재야 장수는 국가에 임관한다.');
    return choice.finish();
  }
  const city = view.cities[general.cityKey]!;
  const ownCities = Object.values(view.cities).filter((c) => c.nationId === general.nationId);
  const front = frontier(view, general.nationId, city.cityKey);
  if (city.nationId !== general.nationId || !city.supplied) choice.add('return', {}, 200, '자기 국가의 보급되는 수도로 돌아간다.');
  for (const spec of DOMESTIC_SPECS) {
    const value = spec.field === 'tech' ? view.nations[general.nationId]!.tech : city[spec.field];
    const max = spec.field === 'tech' ? BALANCE.MAX_TECH : spec.field === 'trust' ? BALANCE.MAX_TRUST : city[`${spec.field}Max`];
    choice.add(spec.key, {}, 10 + Math.round(20 * (1 - value / Math.max(1, max))), '도시와 국가의 부족한 내정 수치를 채운다.');
  }
  for (const key of frontlineSteps(view, general)) choice.add('move', { cityKey: key }, 60, '자기 영토를 따라 가까운 전선으로 간다.');
  if (front && city.nationId === general.nationId) {
    const capacity = general.leadership * BALANCE.CREW_PER_LEADERSHIP;
    const minimum = Math.min(capacity, 2000);
    const unit = context.unitSet?.crewTypes.find((u) => u.id === general.crewType && u.armType > 0);
    if (general.crew < minimum && unit) {
      const amount = Math.min(capacity - general.crew, city.population, Math.floor(general.gold / unit.cost));
      if (amount > 0) choice.add('recruit', { amount, crewType: unit.id }, 120, '전선에서 부족한 병력을 모은다.');
    }
    if (general.train < 60) choice.add('train', {}, 100, '출병 전에 병력을 훈련한다.');
    if (general.atmos < 70) choice.add('morale', {}, 110, '출병에 필요한 사기를 회복한다.');
    if (general.rice < Math.ceil(general.crew * BALANCE.BATTLE_RICE_PER_CREW) * 3) choice.add('trade_rice', { amount: Math.min(1000, general.gold), buy: true }, 115, '출병에 쓸 군량을 마련한다.');
    const assisted = context.convergence !== false && (context.tick ?? 0) >= 50 * 12 * TICKS_PER_MONTH;
    const bonus = assisted ? ownCities.length : 0;
    for (const key of city.connections) {
      const target = view.cities[key]!;
      if (target.nationId === general.nationId) continue;
      choice.add('attack', { cityKey: key }, 80 + bonus, assisted ? '장기전에서는 영토가 넓은 국가의 출병 점수를 높인다.' : '준비한 병력으로 접경 도시를 공격한다.');
    }
  }
  return choice.finish();
}

export function chooseNationTurn(view: WorldView, ruler: General, rng: Rng, context: NpcContext = {}): NpcDecision {
  const nation = ruler.nationId === null ? undefined : view.nations[ruler.nationId];
  if (ruler.userId !== null || !nation?.isNpc || ruler.officerLevel !== BALANCE.RULER_LEVEL) return { chosen: null, candidates: [] };
  const choice = chooser(view, ruler, rng, context, 'nation');
  choice.add('nation_rest', {}, 0, '국가 명령이 없으면 쉰다.');
  const cities = Object.values(view.cities).filter((c) => c.nationId === nation.id);
  const capital = view.cities[nation.capitalCityKey];
  if (!capital?.supplied || (cities.length > 1 && !capital.connections.some((key) => view.cities[key]?.nationId === nation.id))) {
    for (const city of cities) choice.add('nation_capital', { cityKey: city.cityKey }, 200 + city.connections.filter((key) => view.cities[key]?.nationId === nation.id).length, '고립된 수도를 연결된 자기 도시로 옮긴다.');
  }
  const fighting = view.diplomacies.some((d) => (d.nationA === nation.id || d.nationB === nation.id) && (d.state === 'WAR' || d.state === 'DECLARED'));
  if (!fighting) {
    const neighbors = new Set(cities.flatMap((c) => c.connections.map((key) => view.cities[key]!.nationId)));
    for (const id of neighbors) {
      if (id !== null && id !== nation.id && !relation(view, nation.id, id)) choice.add('nation_declare', { nationId: id }, 100, '교전국이 없어 접경 국가에 선전포고한다.');
    }
  }
  if (nation.gold >= 10000) {
    const members = Object.values(view.generals).filter((g) => g.nationId === nation.id && g.activeFromYear <= view.startYear + Math.floor((context.tick ?? 0) / (12 * TICKS_PER_MONTH)));
    const poorest = members.sort((a, b) => a.gold - b.gold || a.id - b.id)[0];
    if (poorest && poorest.gold < 10000) choice.add('nation_reward', { generalId: poorest.id, resource: 'gold', amount: Math.min(10000 - poorest.gold, nation.gold) }, 50, '국고의 금을 자원이 부족한 장수에게 포상한다.');
  }
  return choice.finish();
}
