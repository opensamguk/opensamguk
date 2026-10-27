import { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import { TICKS_PER_MONTH } from '../clock/constants';
import { fail, positive, relation, removeNation, success } from '../commands/support';
import type { Actor, CommandDef, CommandResult } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { refreshSupply } from '../supply';
import { followCampaignCommanders } from './movement';
import { fightCampaignUnits, fightCampaignWall } from './skirmish';
import { readCampaignState, type CampaignUnitState } from './state';

const argsSchema = z.strictObject({ cityKey: positive });
const year = (view: WorldView, tick: number) => view.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
function attackers(view: WorldView, actor: Actor) {
  const owner = view.generals[actor.generalId]!;
  return readCampaignState(view.campaign, view)
    .units.filter((unit) => {
      const commander = view.generals[unit.commanderId]!;
      return (
        unit.ownerId === owner.id &&
        unit.troops > 0 &&
        unit.atmos > 0 &&
        commander.cityKey === owner.cityKey &&
        commander.activeFromYear <= year(view, actor.tick ?? 0)
      );
    })
    .sort((a, b) => a.id - b.id);
}
function defenders(view: WorldView, actor: Actor, cityKey: number) {
  const city = view.cities[cityKey]!;
  return readCampaignState(view.campaign, view)
    .units.filter((unit) => {
      const commander = view.generals[unit.commanderId]!,
        owner = view.generals[unit.ownerId]!;
      return (
        city.nationId !== null &&
        owner.nationId === city.nationId &&
        commander.cityKey === cityKey &&
        commander.activeFromYear <= year(view, actor.tick ?? 0) &&
        unit.troops > 0 &&
        unit.train >= BALANCE.DEFEND_TRAIN &&
        unit.atmos >= BALANCE.DEFEND_ATMOS
      );
    })
    .sort((a, b) => b.troops - a.troops || a.id - b.id);
}
function check(view: WorldView, actor: Actor, raw: unknown) {
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) return fail('BAD_ARGS', '출병 목적지를 확인하세요.');
  const owner = view.generals[actor.generalId];
  if (!owner) return fail('NO_ACTOR', '장수가 없습니다.');
  if (Math.floor((actor.tick ?? 0) / TICKS_PER_MONTH) < (view.presetRules?.protection.peaceMonths ?? 0))
    return fail('PROTECTED', '초반 보호 기간에는 출병할 수 없습니다.');
  if (owner.nationId === null) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
  const from = view.cities[owner.cityKey],
    target = view.cities[parsed.data.cityKey];
  if (!target || target.nationId === owner.nationId)
    return fail('BAD_TARGET', '자기 국가 도시에는 출병할 수 없습니다.');
  if (from?.nationId !== owner.nationId) return fail('NOT_OWN_CITY', '자기 국가 도시에서 출병해야 합니다.');
  if (!from.supplied) return fail('NO_SUPPLY', '보급이 끊긴 도시입니다.');
  if (!from.connections.includes(target.cityKey)) return fail('NOT_ADJACENT', '연결된 도시가 아닙니다.');
  if (target.nationId !== null && relation(view, owner.nationId, target.nationId)?.state !== 'WAR')
    return fail('NOT_WAR', '교전 중인 국가가 아닙니다.');
  if (Object.values(view.generals).some((general) => general.crew !== 0))
    throw new Error('부곡 월드에 장수 병력을 중복 저장할 수 없습니다.');
  const force = attackers(view, actor);
  if (!force.length) return fail('NO_CREW', '같은 거점에 집결한 부곡 병력이나 사기가 부족합니다.');
  const all = [...force, ...defenders(view, actor, target.cityKey)];
  if (
    !actor.unitSet?.crewTypes.some((unit) => unit.id === 1000) ||
    all.some((row) => !actor.unitSet!.crewTypes.some((unit) => unit.id === row.crewType))
  )
    return fail('NO_UNIT_SET', '전투 병종이 없습니다.');
  return null;
}
function execute(view: WorldView, actor: Actor, raw: unknown, rng: Rng): CommandResult {
  const failure = check(view, actor, raw);
  if (failure) throw new Error(failure.message);
  const { cityKey } = argsSchema.parse(raw),
    ownerId = actor.generalId;
  let state = cloneWorld(view);
  const nationId = state.generals[ownerId]!.nationId!,
    defendingNation = state.cities[cityKey]!.nationId;
  const attackingIds = attackers(state, actor).map((unit) => unit.id);
  // 출병 시작 때의 수비 순서를 고정한다. 사람의 예약이나 다른 소유자의 부곡을 공격 편성에 넣지 않는다.
  const defendingIds = defenders(state, actor, cityKey).map((unit) => unit.id);
  const alive = (unit: CampaignUnitState) => unit.troops > 0 && unit.atmos > 0;
  const get = (id: number) => state.campaign!.units.find((unit) => unit.id === id)!;
  const rounds: string[] = [],
    reports: NonNullable<CommandResult['reports']> = [];
  const battleAwards: NonNullable<CommandResult['battleAwards']> = [];
  for (const attackerId of attackingIds) {
    for (const defenderId of defendingIds) {
      if (!alive(get(attackerId))) break;
      if (!alive(get(defenderId))) continue;
      const attackerCommander = get(attackerId).commanderId,
        defenderCommander = get(defenderId).commanderId;
      state = fightCampaignUnits(state, attackerId, defenderId, actor.unitSet!, rng).state;
      const a = get(attackerId),
        d = get(defenderId);
      if (alive(a) && !alive(d)) battleAwards.push({ generalId: attackerCommander, wins: 1, captures: 0 });
      else if (!alive(a) && alive(d)) battleAwards.push({ generalId: defenderCommander, wins: 1, captures: 0 });
      const text = `${state.generals[attackerCommander]!.name} 부곡${attackerId} 대 ${state.generals[defenderCommander]!.name} 부곡${defenderId}: 공격 ${a.troops}명, 수비 ${d.troops}명`;
      rounds.push(text);
      // BattleLog의 (worldId,tick,attackerId,generalId) 키당 한 행으로 저장한다.
      const report = reports.find((row) => row.generalId === defenderCommander);
      if (report) report.text += `; ${text}`;
      else reports.push({ generalId: defenderCommander, text });
      if (alive(d)) break;
    }
    if (defendingIds.some((id) => alive(get(id)))) continue;
    // 기존 출병은 벽이 0이어도 점령 직전 군량을 한 번 소비한다.
    if (alive(get(attackerId))) {
      state = fightCampaignWall(state, attackerId, cityKey, actor.unitSet!, rng).state;
      rounds.push(`부곡${attackerId} 성벽 교전: 공격 ${get(attackerId).troops}명, 성벽 ${state.cities[cityKey]!.wall}`);
    }
    if (state.cities[cityKey]!.wall === 0 && alive(get(attackerId))) break;
  }
  const captured =
    !defendingIds.some((id) => alive(get(id))) &&
    state.cities[cityKey]!.wall === 0 &&
    attackingIds.some((id) => alive(get(id)));
  const history: NonNullable<CommandResult['history']> = [];
  if (captured) {
    battleAwards.push({ generalId: ownerId, wins: 0, captures: 1 });
    const city = state.cities[cityKey]!;
    city.nationId = nationId;
    city.defence = 0;
    city.security = Math.round(city.security * BALANCE.CAPTURE_SECURITY_FACTOR);
    city.trust = Math.max(0, city.trust - BALANCE.CAPTURE_TRUST_LOSS);
    state.generals[ownerId]!.cityKey = cityKey;
    if (defendingNation !== null) {
      const nation = state.nations[defendingNation]!;
      const remaining = Object.values(state.cities)
        .filter((row) => row.nationId === defendingNation && row.kind !== 'PASS')
        .sort((a, b) => b.population - a.population || a.cityKey - b.cityKey);
      if (!remaining.length) {
        removeNation(state, defendingNation);
        history.push({ nationId: defendingNation, text: `${nation.name} 멸망, 소속 장수 재야` });
      } else if (nation.capitalCityKey === cityKey) {
        nation.capitalCityKey = remaining[0]!.cityKey;
        history.push({ nationId: defendingNation, text: `${nation.name} 수도 함락, ${remaining[0]!.name} 천도` });
      }
    }
    refreshSupply(state);
    state = followCampaignCommanders(view, state);
  }
  const troops = attackingIds.reduce((sum, id) => sum + get(id).troops, 0);
  const summary = `${state.generals[ownerId]!.name} ${state.cities[cityKey]!.name} ${captured ? '점령' : '점령 실패'}: 병력 ${troops}명`;
  for (const report of reports) report.text += `, ${captured ? '점령' : '수비 유지'}`;
  history.push({ nationId, text: `${rounds.join('; ')}; ${summary}` });
  if (defendingNation !== null) history.push({ nationId: defendingNation, text: summary });
  readCampaignState(state.campaign, state);
  return {
    ...success(`${rounds.join('\n')}\n${summary}`),
    effects: [{ kind: 'world', state }],
    reports,
    history,
    battleAwards,
  };
}

export const campaignAttack: CommandDef = {
  key: 'attack',
  name: '출병',
  category: 'military',
  target: 'general',
  args: argsSchema,
  check,
  precheck: check,
  execute,
};
