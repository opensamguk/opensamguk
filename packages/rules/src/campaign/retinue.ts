// Adapted from opensamguk-v1 bc053629710711d4c5dfa50683bae78f4baeca95:
// RetinueHierarchy.kt, RenownRules.kt, DeploymentRules.kt (MIT). See NOTICE.
// Campaign snapshots replace v1 province/card profiles. No runtime state is mutated.
export const INITIAL_RENOWN_CAPACITY = 30;
export type SourcedFiveStats = {
  leadership: number;
  strength: number;
  intelligence: number;
  politics: number;
  charm: number;
  source: string;
};
export type RetinuePerson = { id: number; worldId: string; nationId: number; stats: SourcedFiveStats };
export type RetinueLink = { masterId: number; personId: number; relation: 'STAFF' | 'LIEUTENANT' | 'GUEST' };
const natural = (n: number) => Number.isSafeInteger(n) && n >= 0;
const positive = (n: number) => natural(n) && n > 0;
export function retinuePersonCost(stats: SourcedFiveStats): number {
  if (!stats || typeof stats.source !== 'string' || !stats.source.trim()) throw new Error('STATS_SOURCE_REQUIRED');
  const values = [stats.leadership, stats.strength, stats.intelligence, stats.politics, stats.charm];
  if (!values.every(natural)) throw new Error('FIVE_STATS_REQUIRED');
  let sum = 0;
  for (const n of values) {
    sum += n;
    if (!Number.isSafeInteger(sum)) throw new Error('STAT_OVERFLOW');
  }
  return Math.max(1, Math.floor(sum / 50) + (sum % 50 ? 1 : 0));
}
export function buildRetinueHierarchy(people: readonly RetinuePerson[], links: readonly RetinueLink[]) {
  const persons = new Map<number, RetinuePerson>();
  for (const p of people) {
    if (
      !positive(p.id) ||
      !natural(p.nationId) ||
      typeof p.worldId !== 'string' ||
      !p.worldId.trim() ||
      persons.has(p.id)
    )
      throw new Error('INVALID_PEOPLE');
    retinuePersonCost(p.stats);
    persons.set(p.id, { ...p, stats: { ...p.stats } });
  }
  const parent = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const link of links) {
    const master = persons.get(link.masterId);
    const person = persons.get(link.personId);
    if (!master || !person) throw new Error('DANGLING_PERSON');
    if (parent.has(link.personId)) throw new Error('MULTIPLE_SUPERIORS');
    if (master.id === person.id || master.worldId !== person.worldId || master.nationId !== person.nationId)
      throw new Error('INVALID_ALLEGIANCE');
    if (!['STAFF', 'LIEUTENANT', 'GUEST'].includes(link.relation)) throw new Error('INVALID_RELATION');
    parent.set(person.id, master.id);
    children.set(master.id, [...(children.get(master.id) ?? []), person.id]);
  }
  for (const id of persons.keys()) {
    const visited = new Set<number>();
    let cursor: number | undefined = id;
    while (cursor !== undefined) {
      if (visited.has(cursor)) throw new Error('RETINUE_CYCLE');
      visited.add(cursor);
      cursor = parent.get(cursor);
    }
  }
  for (const list of children.values()) list.sort((a, b) => a - b);
  const requirePerson = (id: number) => {
    if (!persons.has(id)) throw new Error('PERSON_NOT_FOUND');
  };
  const directCost = (id: number) => {
    requirePerson(id);
    let total = 0;
    for (const child of children.get(id) ?? []) {
      total += retinuePersonCost(persons.get(child)!.stats);
      if (!Number.isSafeInteger(total)) throw new Error('COST_OVERFLOW');
    }
    return total;
  };
  return {
    ancestors(id: number) {
      requirePerson(id);
      const result: number[] = [];
      let p = parent.get(id);
      while (p !== undefined) {
        result.push(p);
        p = parent.get(p);
      }
      return result;
    },
    subtree(id: number) {
      requirePerson(id);
      const pending = [id];
      const result: number[] = [];
      while (pending.length) {
        const p = pending.pop()!;
        result.push(p);
        pending.push(...[...(children.get(p) ?? [])].reverse());
      }
      return result;
    },

    directCost,
    withinCapacity(id: number, capacity: number) {
      if (!natural(capacity)) throw new Error('INVALID_CAPACITY');
      return directCost(id) <= capacity;
    },
  };
}

export type CampaignDeploymentPerson = RetinuePerson & {
  isUnownedNpc: boolean;
  node: string | null;
  inBattle: boolean;
};
export type CampaignUnit = { id: number; ownerId: number; commanderId: number; troops: number };
// Only identity is stored in deployment metadata; troops remain authoritative in CampaignUnit.
export type CampaignDeployment = {
  id: number;
  worldId: string;
  nationId: number;
  ownerId: number;
  commanderId: number;
  unitIds: readonly number[];
};
export type DeploymentSnapshot = {
  people: readonly CampaignDeploymentPerson[];
  links: readonly RetinueLink[];
  units: readonly CampaignUnit[];
  deployed: readonly CampaignDeployment[];
};
export type DeploymentRequest = { ownerId: number; commanderId: number; unitIds: readonly number[] };
export type DeploymentFailure =
  | 'INVALID_INPUT'
  | 'STATE_UNAVAILABLE'
  | 'OWNER_UNAVAILABLE'
  | 'COMMANDER_UNAVAILABLE'
  | 'DIFFERENT_ALLEGIANCE'
  | 'POSITION_UNAVAILABLE'
  | 'MUST_ASSEMBLE'
  | 'BATTLE_PENDING'
  | 'UNIT_UNAVAILABLE'
  | 'COMMANDER_CHANGED'
  | 'ALREADY_DEPLOYED';
export type DeploymentAssessment =
  { ok: true; ownerId: number; commanderId: number; unitIds: number[] } | { ok: false; reason: DeploymentFailure };
export function assessCampaignDeployment(
  request: DeploymentRequest,
  state: DeploymentSnapshot,
  activeId?: number,
): DeploymentAssessment {
  const deny = (reason: DeploymentFailure): DeploymentAssessment => ({ ok: false, reason });
  if (
    !positive(request.ownerId) ||
    !positive(request.commanderId) ||
    !request.unitIds.length ||
    !request.unitIds.every(positive) ||
    new Set(request.unitIds).size !== request.unitIds.length
  )
    return deny('INVALID_INPUT');
  if (
    [state.people, state.units, state.deployed].some(
      (items) => new Set(items.map((i) => i.id)).size !== items.length || items.some((i) => !positive(i.id)),
    )
  )
    return deny('STATE_UNAVAILABLE');
  try {
    buildRetinueHierarchy(state.people, state.links);
  } catch {
    return deny('STATE_UNAVAILABLE');
  }
  const owner = state.people.find((p) => p.id === request.ownerId);
  if (!owner) return deny('OWNER_UNAVAILABLE');
  const commander = state.people.find((p) => p.id === request.commanderId);
  if (!commander) return deny('COMMANDER_UNAVAILABLE');
  if (
    commander.id !== owner.id &&
    (!commander.isUnownedNpc ||
      !state.links.some((l) => l.masterId === owner.id && l.personId === commander.id && l.relation === 'LIEUTENANT'))
  )
    return deny('COMMANDER_UNAVAILABLE');
  if (owner.nationId !== commander.nationId || owner.worldId !== commander.worldId) return deny('DIFFERENT_ALLEGIANCE');
  for (const id of request.unitIds) {
    const unit = state.units.find((u) => u.id === id);
    if (!unit || unit.ownerId !== owner.id || !positive(unit.troops)) return deny('UNIT_UNAVAILABLE');
    if (unit.commanderId !== commander.id) return deny('COMMANDER_CHANGED');
  }
  if (
    state.deployed.some(
      (d) =>
        !positive(d.ownerId) ||
        !positive(d.commanderId) ||
        !d.unitIds.length ||
        !d.unitIds.every(positive) ||
        new Set(d.unitIds).size !== d.unitIds.length,
    )
  )
    return deny('STATE_UNAVAILABLE');
  if (activeId !== undefined) {
    const current = state.deployed.find((d) => d.id === activeId);
    if (
      !current ||
      current.ownerId !== owner.id ||
      current.commanderId !== commander.id ||
      current.worldId !== owner.worldId ||
      current.nationId !== owner.nationId ||
      current.unitIds.length !== request.unitIds.length ||
      !current.unitIds.every((id) => request.unitIds.includes(id))
    )
      return deny('STATE_UNAVAILABLE');
  }
  if (
    state.deployed.some(
      (d) =>
        d.id !== activeId && (d.commanderId === commander.id || d.unitIds.some((id) => request.unitIds.includes(id))),
    )
  )
    return deny('ALREADY_DEPLOYED');
  if (activeId === undefined) {
    if (owner.inBattle || commander.inBattle) return deny('BATTLE_PENDING');
    if (
      !owner.node ||
      !commander.node ||
      !/^(city|pass|port|field):[a-z0-9_-]+$/.test(owner.node) ||
      !/^(city|pass|port|field):[a-z0-9_-]+$/.test(commander.node)
    )
      return deny('POSITION_UNAVAILABLE');
    if (owner.node !== commander.node) return deny('MUST_ASSEMBLE');
  }
  return {
    ok: true,
    ownerId: owner.id,
    commanderId: commander.id,
    unitIds: [...request.unitIds].sort((a, b) => a - b),
  };
}
