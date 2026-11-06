import { rngFor } from '@opensamguk/shared';
import { TICKS_PER_MONTH } from '../clock/constants';
import { monthlyDate } from '../monthly';
import type { WorldView } from '../model/world';
import { generateLineageChild, lineageBirthEligibility, type LineageResources } from './birth';
import { LINEAGE_MAX } from './config';
import { heirEligibility, lineageActive, lineageAlive, lineageDescendants, marriageEligibility } from './eligibility';
import { assertLineageFinal } from './invariants';
import { reconcileLineage } from './reconcile';
import { applySuccession, retireNpcWithoutHeir } from './succession';

export interface LineageMonthEffects {
  tick: number;
  year: number;
  month: number;
  deaths: { generalId: number; successorId: number | null; loss: { gold: number; rice: number; troops: number } }[];
  rulers: { nationId: number; generalId: number | null }[];
  marriages: { marriageId: number; a: number; b: number; householdGeneralId: number }[];
  births: { generalId: number; marriageId: number; parents: [number, number] }[];
  skippedBirths: { marriageId: number; reason: string }[];
}
function coins(world: WorldView) {
  return [...Object.values(world.generals), ...Object.values(world.nations)].reduce(
    (sum, holder) => ({ gold: sum.gold + BigInt(holder.gold), rice: sum.rice + BigInt(holder.rice) }),
    { gold: 0n, rice: 0n },
  );
}

export function settleLineageMonthly(world: WorldView, tick: number, resources: LineageResources) {
  if (!world.ruleFeatures?.includes('lineage-v1') || !world.lineage) throw new Error('가문 정산 상태가 없습니다.');
  if (tick !== world.lineage.monthlyTick + TICKS_PER_MONTH)
    throw new Error('가문 월 정산이 중복되거나 달을 건너뛰었습니다.');
  const date = monthlyDate(world.startYear, tick);
  const eligibilityTick = tick - 1;
  const effects: LineageMonthEffects = {
    tick,
    ...date,
    deaths: [],
    rulers: [],
    marriages: [],
    births: [],
    skippedBirths: [],
  };
  let state = reconcileLineage(world, tick);
  const beforeCoins = coins(world);
  if (date.month === 1)
    for (const general of Object.values(state.generals))
      if (lineageAlive(state, general.id)) general.age = Math.max(0, date.year - general.birthYear);
  const ids = Object.keys(state.generals)
    .map(Number)
    .sort((a, b) => a - b);
  for (const id of ids) {
    const general = state.generals[id]!;
    if (!lineageActive(state, id, eligibilityTick) || general.userId !== null) continue;
    const month = rngFor(state.lineage!.seed, 'lineage-death', id).int(1, 12);
    if (!(date.year > general.deathYear || (date.year === general.deathYear && date.month >= month))) continue;
    const heir = lineageDescendants(state, id, state.lineage!.config.heir.depth)
      .filter((candidate) => !heirEligibility(state, id, candidate, eligibilityTick))
      .sort((a, b) => state.generals[a]!.birthYear - state.generals[b]!.birthYear || a - b)[0];
    const outcome =
      heir === undefined ? retireNpcWithoutHeir(state, id, tick) : applySuccession(state, id, heir, 'NPC_DEATH', tick);
    if (!outcome.ok) throw new Error(`NPC 사망 처리 실패: ${outcome.code}`);
    state = outcome.world;
    effects.deaths.push({ generalId: id, successorId: heir ?? null, loss: outcome.loss });
  }
  for (const nation of Object.values(state.nations).sort((a, b) => a.id - b.id)) {
    if (!Object.values(state.cities).some((city) => city.nationId === nation.id && city.kind !== 'PASS')) continue;
    const active = Object.values(state.generals).filter(
      (general) => general.nationId === nation.id && lineageActive(state, general.id, eligibilityTick),
    );
    if (active.some((general) => general.officerLevel === 12)) continue;
    const ruler = active
      .filter((general) => general.userId === null)
      .sort((a, b) => b.officerLevel - a.officerLevel || a.id - b.id)[0];
    if (ruler) {
      ruler.officerLevel = 12;
      nation.isNpc = true;
    }
    effects.rulers.push({ nationId: nation.id, generalId: ruler?.id ?? null });
  }
  const lineage = state.lineage!,
    config = lineage.config;
  const rng = rngFor(lineage.seed, 'lineage', date.year, date.month);
  const npcs = Object.values(state.generals)
    .filter((general) => general.userId === null && lineageActive(state, general.id, eligibilityTick))
    .sort((a, b) => (a.nationId ?? 0) - (b.nationId ?? 0) || a.id - b.id);
  for (const actor of npcs) {
    if (effects.marriages.length >= config.marriage.npc.perMonth) break;
    if (actor.sex === 'UNKNOWN' || lineage.marriages.some((row) => row.a === actor.id || row.b === actor.id)) continue;
    const candidate = npcs.find(
      (other) =>
        other.nationId === actor.nationId &&
        other.sex !== actor.sex &&
        other.sex !== 'UNKNOWN' &&
        !lineage.marriages.some((row) => row.a === other.id || row.b === other.id) &&
        Math.abs(other.affinity - actor.affinity) <= config.marriage.npc.affinityGap &&
        !marriageEligibility(state, actor.id, other.id, eligibilityTick),
    );
    if (!candidate) continue;
    if (rng.int(0, 9999) >= config.marriage.npc.chanceBp) continue;
    if (lineage.nextMarriageId === LINEAGE_MAX) break;
    const marriage = {
      id: lineage.nextMarriageId++,
      a: Math.min(actor.id, candidate.id),
      b: Math.max(actor.id, candidate.id),
      householdGeneralId: actor.id,
      sinceTick: tick,
    };
    lineage.marriages.push(marriage);
    effects.marriages.push({ marriageId: marriage.id, a: marriage.a, b: marriage.b, householdGeneralId: actor.id });
  }
  // 설정1의 기존 원생성은 연간 출산과 같은 난수 순서를 유지한다.
  const birthsThisYear =
    config.version === 2
      ? Object.values(lineage.persons).filter(
          (person) => person.bornTick !== null && monthlyDate(world.startYear, person.bornTick).year === date.year,
        ).length
      : 0;
  if (config.version === 2 || date.month === 1)
    for (const marriage of [...lineage.marriages].sort((a, b) => a.id - b.id)) {
      if (
        birthsThisYear + effects.births.length >= config.limits.maxBirthsPerYear ||
        Object.keys(state.generals).length >= config.limits.maxGenerals
      ) {
        effects.skippedBirths.push({ marriageId: marriage.id, reason: 'LIMIT' });
        break;
      }
      if (lineageBirthEligibility(state, marriage.id, eligibilityTick)) continue;
      if (rng.int(0, 9999) >= config.birth.chanceBp) continue;
      const born = generateLineageChild(state, marriage.id, tick, resources);
      if (!born.ok) {
        effects.skippedBirths.push({ marriageId: marriage.id, reason: born.code });
        continue;
      }
      state.generals[born.general.id] = born.general;
      lineage.persons[String(born.general.id)] = born.person;
      if (state.campaign) {
        if (state.campaign.revision === LINEAGE_MAX) throw new Error('부곡 변경 번호 한도에 닿았습니다.');
        state.campaign.sources[String(born.general.id)] = born.source;
        state.campaign.revision++;
      }
      effects.births.push({ generalId: born.general.id, marriageId: marriage.id, parents: born.person.parents });
    }
  if (world.lineage.revision === LINEAGE_MAX) throw new Error('가문 변경 번호 한도에 닿았습니다.');
  lineage.monthlyTick = tick;
  lineage.revision = world.lineage.revision + 1;
  const afterCoins = coins(state);
  if (
    JSON.stringify(world.cities) !== JSON.stringify(state.cities) ||
    JSON.stringify(world.cityResources) !== JSON.stringify(state.cityResources)
  )
    throw new Error('가문 정산이 도시·도시 자원을 바꿨습니다.');
  const losses = effects.deaths.reduce(
    (sum, row) => ({ gold: sum.gold + BigInt(row.loss.gold), rice: sum.rice + BigInt(row.loss.rice) }),
    { gold: 0n, rice: 0n },
  );
  if (beforeCoins.gold !== afterCoins.gold + losses.gold || beforeCoins.rice !== afterCoins.rice + losses.rice)
    throw new Error('가문 정산의 금·쌀 보존 감사가 실패했습니다.');
  assertLineageFinal(state, tick);
  return { state, effects };
}
