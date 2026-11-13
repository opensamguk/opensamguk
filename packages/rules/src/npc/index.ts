import { combatSpecialty } from '../general/combatSpecialty';
import type { Rng } from '@opensamguk/shared';
import { personalityEffects } from '../general/personality';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import { commandRegistry } from '../commands/registry';
import { DOMESTIC_SPECS } from '../commands/domestic/investment';
import { affordableRecruits, commandFiveStats, domesticStatScore, drillGain } from '../commands/statScores';
import { relation } from '../commands/support';
import type { Actor } from '../commands/types';
import type { DeepReadonly, WorldView } from '../model/world';
import type { InitialGeneral } from '../world/bootstrap';
import type { CommandResolver } from '../commands/resolve';
import { readCampaignState } from '../campaign/state';
import { cityNpcAllocations, cityNpcPreparation } from '../cityResources/npc';
import { frontier } from './frontier';
import { npcNationPolicy, npcRecruitPopulation } from './policy';
export { NPC_DEFAULT_POLICY } from './policy';
import { crewContext, crewTypeFailure } from '../world/crewRequirements';
import { nationStrategyNpcCandidates } from '../nationStrategy/npc';

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
  resolver?: CommandResolver | undefined;
  worldSeed?: string | undefined;
}
type General = DeepReadonly<InitialGeneral>;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function chooser(view: WorldView, general: General, context: NpcContext, target: 'general' | 'nation') {
  const candidates: NpcCandidate[] = [];
  const policy = npcNationPolicy(view, general.nationId === null ? undefined : view.nations[general.nationId]);
  const priority: readonly string[] | undefined = target === 'general' ? policy.generalPriority : policy.nationPriority;
  const fallback = target === 'general' ? 'rest' : 'nation_rest';
  const actor: Actor = {
    generalId: general.id,
    tick: context.tick ?? 0,
    unitSet: context.unitSet,
    target,
    worldSeed: context.worldSeed,
  };
  return {
    add(key: string, args: Record<string, unknown>, score: number, reason: string) {
      if (priority && key !== fallback && !priority.includes(key)) return;
      const command = context.resolver ? context.resolver.get(key) : commandRegistry.get(key);
      const parsed = command?.args.safeParse(args);
      if (command?.target === target && parsed?.success && !command.check(view, actor, parsed.data)) {
        const aggression = view.presetRules?.npc.aggression ?? 1;
        const weighted =
          aggression !== 1 && (key === 'attack' || key === 'nation_declare') ? score * aggression : score;
        candidates.push({ key, args, score: weighted, reason });
      }
    },
    finish(): NpcCandidate[] {
      if (priority) {
        const scores = candidates.map(({ score }) => score);
        const spread = Math.max(0, ...scores) - Math.min(0, ...scores) + 1;
        for (const candidate of candidates) {
          if (candidate.key !== fallback)
            candidate.score += (priority.length - priority.indexOf(candidate.key)) * spread;
        }
      }
      candidates.sort(
        (a, b) =>
          b.score - a.score || compareText(a.key, b.key) || compareText(JSON.stringify(a.args), JSON.stringify(b.args)),
      );
      return candidates;
    },
  };
}

function decision(candidates: NpcCandidate[], rng: Rng): NpcDecision {
  return {
    chosen: candidates.length ? rng.pick(candidates.filter((c) => c.score === candidates[0]!.score)) : null,
    candidates,
  };
}

// 자기 영토의 BFS로 전선까지 한 칸을 고른다. ID 순서로 동률을 고정한다.
function frontlineSteps(view: WorldView, general: General): number[] {
  const start = view.cities[general.cityKey]!;
  if (frontier(view, general.nationId!, start.cityKey)) return [];
  const queue = start.connections
    .filter((key) => view.cities[key]?.nationId === general.nationId)
    .sort((a, b) => a - b)
    .map((key) => ({ key, first: key, distance: 1 }));
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
      if (!seen.has(key) && view.cities[key]?.nationId === general.nationId)
        queue.push({ key, first: item.first, distance: item.distance + 1 });
    }
  }
  return [...steps].sort((a, b) => a - b);
}

export function chooseGeneralTurn(view: WorldView, general: General, rng: Rng, context: NpcContext = {}): NpcDecision {
  if (general.removedAt !== undefined || general.userId !== null) return { chosen: null, candidates: [] };
  return decision(generalTurnCandidates(view, general, context), rng);
}

const autoplayCommands = new Set([
  ...DOMESTIC_SPECS.map(({ key }) => key),
  'recruit',
  'train',
  'morale',
  'return',
  'move',
  'attack',
]);

export function chooseAutoplayTurn(view: WorldView, general: General, rng: Rng, context: NpcContext) {
  return decision(
    generalTurnCandidates(view, general, context).filter(({ key }) => autoplayCommands.has(key)),
    rng,
  ).chosen;
}

// 사람 조언도 실제 소유권과 권한을 유지한 채 같은 후보 계산을 쓴다.
export function generalTurnCandidates(view: WorldView, general: General, context: NpcContext = {}): NpcCandidate[] {
  if (general.removedAt !== undefined) return [];
  const stats = commandFiveStats(view, general);
  const militaryScore = stats ? Math.max(stats.leadership, stats.strength) : 0;
  const choice = chooser(view, general, context, 'general');
  choice.add('rest', {}, 0, '실행할 명령이 없으면 쉰다.');
  if (general.nationId === null) {
    for (const nation of Object.values(view.nations))
      choice.add('join', { nationId: nation.id }, 100, '재야 장수는 국가에 임관한다.');
    return choice.finish();
  }
  const city = view.cities[general.cityKey]!;
  const ownCities = Object.values(view.cities).filter((c) => c.nationId === general.nationId);
  const front = frontier(view, general.nationId, city.cityKey);
  if (city.nationId !== general.nationId || !city.supplied)
    choice.add('return', {}, 200, '자기 국가의 보급되는 수도로 돌아간다.');
  for (const spec of DOMESTIC_SPECS) {
    const value = spec.field === 'tech' ? view.nations[general.nationId]!.tech : city[spec.field];
    const max =
      spec.field === 'tech' ? BALANCE.MAX_TECH : spec.field === 'trust' ? BALANCE.MAX_TRUST : city[`${spec.field}Max`];
    choice.add(
      spec.key,
      {},
      (front ? 10 : 70) +
        Math.round(20 * (1 - value / Math.max(1, max))) +
        (stats ? domesticStatScore(view, general, spec.key, spec.stat) : 0),
      front ? '도시와 국가의 부족한 내정 수치를 채운다.' : '후방에서는 전선 이동보다 부족한 내정을 먼저 채운다.',
    );
  }
  for (const key of frontlineSteps(view, general))
    choice.add(
      'move',
      { cityKey: key },
      60 + militaryScore,
      '후방에서 자기 영토를 따라 가까운 전선으로 한 칸 이동한다.',
    );
  if (front && city.nationId === general.nationId) {
    const policy = npcNationPolicy(view, view.nations[general.nationId]);
    const campaign = view.ruleFeatures?.includes('campaign-v1') ? readCampaignState(view.campaign, view) : undefined;
    const owned = campaign?.units.filter((unit) => unit.ownerId === general.id).sort((a, b) => a.id - b.id);
    const army = owned?.[0];
    const commander = army ? view.generals[army.commanderId]! : general;
    const troops = campaign ? (army?.troops ?? 0) : general.crew;
    const train = campaign ? (army?.train ?? 0) : general.train;
    const atmos = campaign ? (army?.atmos ?? 0) : general.atmos;
    const crewType = army?.crewType ?? general.crewType;
    const commanded = campaign
      ? campaign.units.filter((unit) => unit.commanderId === commander.id).reduce((sum, unit) => sum + unit.troops, 0)
      : general.crew;
    const capacity = commander.leadership * BALANCE.CREW_PER_LEADERSHIP;
    const minimum = Math.min(capacity, policy.recruitTarget);
    const requirements = crewContext(view, { generalId: general.id, tick: context.tick ?? 0 });
    const preferred = context.unitSet?.crewTypes.find((u) => u.id === crewType && u.armType > 0);
    const unit =
      (preferred && !crewTypeFailure(preferred, requirements) ? preferred : undefined) ??
      (preferred && troops === 0
        ? context.unitSet?.crewTypes
            .filter((u) => u.armType > 0 && !crewTypeFailure(u, requirements))
            .sort((a, b) => a.id - b.id)[0]
        : undefined);
    const cityResources = view.ruleFeatures?.includes('city-resources-v1') ?? false;
    if (cityResources)
      for (const candidate of cityNpcPreparation(view, general.id, context))
        choice.add(candidate.key, candidate.args, candidate.score, candidate.reason);
    if (!cityResources && troops < minimum && unit && npcRecruitPopulation(policy, city)) {
      const limit = Math.min(capacity - commanded, city.population);
      const amount =
        stats ||
        personalityEffects(view, general.personality)?.recruitPercent !== undefined ||
        combatSpecialty(view, general.special)?.armType === unit.armType
          ? affordableRecruits(view, general, unit.cost, limit, unit.armType)
          : Math.min(limit, Math.floor(general.gold / unit.cost));
      if (amount > 0)
        choice.add(
          'recruit',
          { amount, crewType: unit.id, ...(army ? { unitId: army.id } : {}) },
          120 + (stats ? Math.round((stats.charm - 50) / 2) : 0),
          '전선에서 부족한 병력을 모은다.',
        );
    }
    if (!cityResources && train < policy.trainingTarget)
      choice.add(
        'train',
        army ? { unitId: army.id } : {},
        100 + (stats ? (drillGain(view, commander, false) - 10) * 10 : 0),
        '출병 전에 병력을 훈련한다.',
      );
    if (!cityResources && atmos < policy.moraleTarget)
      choice.add(
        'morale',
        army ? { unitId: army.id } : {},
        110 + (stats ? (drillGain(view, commander, true) - 10) * 10 : 0),
        '출병에 필요한 사기를 회복한다.',
      );
    const battleTroops = campaign
      ? (owned ?? [])
          .filter((unit) => view.generals[unit.commanderId]!.cityKey === general.cityKey)
          .reduce((sum, unit) => sum + unit.troops, 0)
      : general.crew;
    if (general.rice < Math.ceil(battleTroops * BALANCE.BATTLE_RICE_PER_CREW) * 3)
      choice.add('trade_rice', { amount: Math.min(1000, general.gold), buy: true }, 115, '출병에 쓸 군량을 마련한다.');
    const assisted = context.convergence !== false && (context.tick ?? 0) >= 50 * 12 * TICKS_PER_MONTH;
    const bonus = assisted ? ownCities.length : 0;
    for (const key of city.connections) {
      const target = view.cities[key]!;
      if (target.nationId === general.nationId) continue;
      choice.add(
        'attack',
        { cityKey: key },
        80 + bonus + militaryScore,
        assisted ? '장기전에서는 영토가 넓은 국가의 출병 점수를 높인다.' : '준비한 병력으로 접경 도시를 공격한다.',
      );
    }
  }
  return choice.finish();
}

export function chooseNationTurn(view: WorldView, ruler: General, rng: Rng, context: NpcContext = {}): NpcDecision {
  if (ruler.userId !== null || ruler.nationId === null || !view.nations[ruler.nationId]?.isNpc)
    return { chosen: null, candidates: [] };
  return decision(nationTurnCandidates(view, ruler, context), rng);
}

export function nationTurnCandidates(view: WorldView, ruler: General, context: NpcContext = {}): NpcCandidate[] {
  const nation = ruler.nationId === null ? undefined : view.nations[ruler.nationId];
  if (ruler.removedAt !== undefined || !nation || ruler.officerLevel !== BALANCE.RULER_LEVEL) return [];
  const choice = chooser(view, ruler, context, 'nation');
  choice.add('nation_rest', {}, 0, '국가 명령이 없으면 쉰다.');
  for (const candidate of nationStrategyNpcCandidates(view, nation.id, context.tick ?? 0))
    choice.add(candidate.key, candidate.args, candidate.score, candidate.reason);
  if (view.ruleFeatures?.includes('city-resources-v1'))
    for (const candidate of cityNpcAllocations(view, nation.id))
      choice.add(candidate.key, candidate.args, candidate.score, candidate.reason);
  const cities = Object.values(view.cities).filter((c) => c.nationId === nation.id);
  const capital = nation.capitalCityKey === null ? undefined : view.cities[nation.capitalCityKey];
  if (
    !capital?.supplied ||
    (cities.length > 1 && !capital.connections.some((key) => view.cities[key]?.nationId === nation.id))
  ) {
    for (const city of cities) {
      const connections = city.connections.filter((key) => view.cities[key]?.nationId === nation.id).length;
      if (connections > 0 || !capital?.supplied)
        choice.add(
          'nation_capital',
          { cityKey: city.cityKey },
          200 + connections,
          '고립된 수도를 연결된 자기 도시로 옮긴다.',
        );
    }
  }
  const fighting = view.diplomacies.some(
    (d) => (d.nationA === nation.id || d.nationB === nation.id) && (d.state === 'WAR' || d.state === 'DECLARED'),
  );
  if (!fighting) {
    const neighbors = new Set(cities.flatMap((c) => c.connections.map((key) => view.cities[key]!.nationId)));
    for (const id of neighbors) {
      if (id !== null && id !== nation.id && !relation(view, nation.id, id))
        choice.add('nation_declare', { nationId: id }, 100, '교전국이 없어 접경 국가에 선전포고한다.');
    }
  }
  const policy = npcNationPolicy(view, nation);
  const { rewardGoldTarget } = policy;
  const availableGold = Math.max(0, nation.gold - (policy.reserveGold ?? 0));
  if (nation.gold >= rewardGoldTarget && availableGold > 0) {
    const members = Object.values(view.generals).filter(
      (g) =>
        g.removedAt === undefined &&
        g.nationId === nation.id &&
        g.activeFromYear <= view.startYear + Math.floor((context.tick ?? 0) / (12 * TICKS_PER_MONTH)),
    );
    const poorest = members.sort((a, b) => a.gold - b.gold || a.id - b.id)[0];
    const amount = poorest
      ? Math.min(rewardGoldTarget - poorest.gold, availableGold, policy.maxReward ?? availableGold)
      : 0;
    if (poorest && amount > 0 && amount >= (policy.minReward ?? 0))
      choice.add(
        'nation_reward',
        { generalId: poorest.id, resource: 'gold', amount },
        50,
        '국고의 금을 자원이 부족한 장수에게 포상한다.',
      );
  }
  return choice.finish();
}
