import { logPartsToText, type LogPart } from '@opensamguk/shared';
import { commandLog } from '../commands/support';
import { logSentence, nationPart, generalPart, cityPart, numPart, textPart } from '../commands/logging';
import { commandAttackTargets } from '../commandPaths';
import { captureCounties } from '../cityAffiliation';
import { marchSupplyArgs, previewMarchSupply, applyMarchSupply, marchForce } from './supply';
import { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import { canDefend } from '../battle/defenders';
import { TICKS_PER_MONTH } from '../clock/constants';
import { fail, positive, relation, removeNation, success } from '../commands/support';
import type { Actor, CommandDef, CommandResult } from '../commands/types';
import { cloneWorld } from '../model/clone';
import type { WorldView } from '../model/world';
import { refreshSupply } from '../supply';
import { followCampaignCommanders } from './movement';
import { fightCampaignCityGarrison, fightCampaignUnits, fightCampaignWall } from './skirmish';
import { readCampaignState, type CampaignUnitState } from './state';
import { readCityResourcesState } from '../cityResources/state';
import { disbandCityGarrison } from '../cityResources/ownership';
import { battleBusy, openTacticalBattle } from '../tactical/world';
import { reputationBattleEvents } from '../review/events';

const argsSchema = z.strictObject({ cityKey: positive, ...marchSupplyArgs });
const year = (view: WorldView, tick: number) => view.startYear + Math.floor(tick / (12 * TICKS_PER_MONTH));
export function campaignAttackingUnits(view: WorldView, actor: Actor) {
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
export function campaignDefenders(view: WorldView, tick: number, cityKey: number) {
  const city = view.cities[cityKey]!;
  return readCampaignState(view.campaign, view)
    .units.filter((unit) => {
      const commander = view.generals[unit.commanderId]!,
        owner = view.generals[unit.ownerId]!;
      return (
        city.nationId !== null &&
        owner.nationId === city.nationId &&
        commander.cityKey === cityKey &&
        commander.activeFromYear <= year(view, tick) &&
        canDefend(unit.troops, unit.train, unit.atmos)
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
  const path = commandAttackTargets(view, owner.id).find((row) => row.cityKey === target.cityKey);
  if (!path) return fail('NOT_ADJACENT', '연결된 도시가 아닙니다.');
  if (path.blockedBy !== null)
    return fail('BLOCKED_BY_COUNTY', `${view.cities[path.blockedBy]!.name}: 수비 있는 현이 길을 막습니다.`);
  if (target.nationId !== null && relation(view, owner.nationId, target.nationId)?.state !== 'WAR')
    return fail('NOT_WAR', '교전 중인 국가가 아닙니다.');
  if (Object.values(view.generals).some((general) => general.crew !== 0))
    throw new Error('부곡 월드에 장수 병력을 중복 저장할 수 없습니다.');
  const force = campaignAttackingUnits(view, actor);
  if (battleBusy(view, { cityKeys: [parsed.data.cityKey], generalIds: [owner.id], unitIds: force.map((u) => u.id) }))
    return fail('BATTLE_BUSY', '전투 중');
  if (!force.length) return fail('NO_CREW', '같은 거점에 집결한 부곡 병력이나 사기가 부족합니다.');
  if (force.some((unit) => unit.supply) && force.some((unit) => !unit.supply))
    return fail('BAD_STATE', '귀환을 마친 뒤 새 부곡과 함께 출병하세요.');
  const all = [...force, ...campaignDefenders(view, actor.tick ?? 0, target.cityKey)];
  readCityResourcesState(
    view.cityResources,
    view,
    actor.unitSet?.crewTypes.filter((row) => row.armType > 0).map((row) => row.id),
  );
  if (
    !actor.unitSet?.crewTypes.some((unit) => unit.id === 1000) ||
    all.some((row) => !actor.unitSet!.crewTypes.some((unit) => unit.id === row.crewType))
  )
    return fail('NO_UNIT_SET', '전투 병종이 없습니다.');
  if (view.campaign?.supplyLedger) {
    try {
      const preview = cloneWorld(view);
      openTacticalBattle(
        preview,
        actor.tick ?? 0,
        force as CampaignUnitState[],
        campaignDefenders(view, actor.tick ?? 0, target.cityKey) as CampaignUnitState[],
        target.cityKey,
        actor.unitSet!,
        parsed.data,
      );
    } catch {
      return fail('BAD_TARGET', '전장 지도·배치·병종을 사용할 수 없습니다.');
    }
    let preview;
    const army = marchForce(force);
    try {
      preview = previewMarchSupply(view, army, parsed.data.cityKey, parsed.data);
    } catch {
      return fail('BAD_TARGET', '행군 경로를 사용할 수 없습니다.');
    }
    if (preview) {
      if (army.supply && parsed.data.supplyLoad !== undefined)
        return fail('BAD_ARGS', '행군 중에는 보급을 다시 적재할 수 없습니다.');
      for (const key of ['routeRevision', 'ownershipRevision', 'diplomacyRevision'] as const)
        if (parsed.data[key] !== undefined && parsed.data[key] !== preview[key])
          return fail('STALE_SUPPLY_PREVIEW', '보급 미리보기가 오래됐습니다. 다시 확인하세요.');
      if ((view.cityResources?.cities[String(owner.cityKey)]?.rice ?? 0) < preview.riceCost)
        return fail('NO_RICE', '출병 도시의 쌀이 부족합니다.');
    }
  }
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
  const force = campaignAttackingUnits(state, actor);
  const marchLogs: string[] = [];
  if (!applyMarchSupply(state, force, cityKey, argsSchema.parse(raw)))
    marchLogs.push('보급 고갈: 원정 병력을 해산하고 장수들이 복귀했습니다.');
  const attackingIds = force
    .map((unit) => unit.id)
    .filter((id) => state.campaign!.units.some((unit) => unit.id === id));
  if (!attackingIds.length) {
    state.campaign!.revision++;
    return {
      ...success(marchLogs.join('\n')),
      effects: [{ kind: 'world', state }],
      history: [{ nationId, text: marchLogs.join('; ') }],
    };
  }
  if (state.cities[cityKey]!.state != null) {
    state.cities[cityKey]!.state = 43;
    state.cities[cityKey]!.stateTerm = 3;
  }
  // 출병 시작 때의 수비 순서를 고정한다. 사람의 예약이나 다른 소유자의 부곡을 공격 편성에 넣지 않는다.
  const defendingIds = campaignDefenders(state, actor.tick ?? 0, cityKey).map((unit) => unit.id);
  if (
    state.campaign!.supplyLedger &&
    !(
      state.cities[cityKey]!.kind === 'FIELD' &&
      !defendingIds.length &&
      !state.cityResources?.cities[String(cityKey)]?.garrison.some((u) => u.troops > 0)
    )
  ) {
    const battle = openTacticalBattle(
      state,
      actor.tick ?? 0,
      attackingIds.map((id) => state.campaign!.units.find((u) => u.id === id)!),
      defendingIds.map((id) => state.campaign!.units.find((u) => u.id === id)!),
      cityKey,
      actor.unitSet!,
      argsSchema.parse(raw),
    );
    return {
      ...success(`${state.cities[cityKey]!.name} 작전 회의: ${battle.id}`),
      effects: [{ kind: 'world', state }],
      attackTarget: { cityKey, defendingNationId: defendingNation },
    };
  }
  const cityDefense = () => state.cityResources!.cities[String(cityKey)]!.garrison;
  const alive = (unit: CampaignUnitState) => unit.troops > 0 && unit.atmos > 0;
  const get = (id: number) => state.campaign!.units.find((unit) => unit.id === id)!;
  const rounds: LogPart[][] = marchLogs.map((line) => [textPart(line)]),
    reports: NonNullable<CommandResult['reports']> = [];
  const battleAwards: NonNullable<CommandResult['battleAwards']> = [];
  const battleOutcomes: NonNullable<CommandResult['battleOutcomes']> = [];
  for (const attackerId of attackingIds) {
    let attackerFirstVolleyUsed = false;
    const fightWall = (openingSkirmish = false) => {
      const outcome = fightCampaignWall(state, attackerId, cityKey, actor.unitSet!, rng, {
        openingSkirmish,
        attackerFirstVolleyUsed,
      });
      state = outcome.state;
      attackerFirstVolleyUsed ||= outcome.attackerFirstVolleyFired === true;
      const name = openingSkirmish ? '성벽 선제 교전' : '성벽 교전';
      rounds.push([
        textPart(`부곡${attackerId} ${name}: 공격 `),
        numPart(get(attackerId).troops),
        textPart('명, 성벽 '),
        numPart(state.cities[cityKey]!.wall),
      ]);
    };
    const wallFirst =
      state.cities[cityKey]!.wall > 0 &&
      actor.unitSet!.crewTypes.find((unit) => unit.id === get(attackerId).crewType)?.effects?.includes('wallFirst') &&
      (defendingIds.some((id) => alive(get(id))) || cityDefense().some((row) => row.troops > 0 && row.atmos > 0));
    if (wallFirst) {
      fightWall(true);
      if (!alive(get(attackerId))) continue;
    }
    for (const defenderId of defendingIds) {
      if (!alive(get(attackerId))) break;
      if (!alive(get(defenderId))) continue;
      const attackerCommander = get(attackerId).commanderId,
        defenderCommander = get(defenderId).commanderId;
      const outcome = fightCampaignUnits(state, attackerId, defenderId, actor.unitSet!, rng, attackerFirstVolleyUsed);
      state = outcome.state;
      attackerFirstVolleyUsed ||= outcome.attackerFirstVolleyFired === true;
      const a = get(attackerId),
        d = get(defenderId);
      if (alive(a) && !alive(d)) {
        battleAwards.push({ generalId: attackerCommander, wins: 1, captures: 0 });
        battleOutcomes.push({ winnerId: attackerCommander, loserId: defenderCommander });
      } else if (!alive(a) && alive(d)) {
        battleAwards.push({ generalId: defenderCommander, wins: 1, captures: 0 });
        battleOutcomes.push({ winnerId: defenderCommander, loserId: attackerCommander });
      }
      const parts: LogPart[] = [
        generalPart(state.generals[attackerCommander]!),
        textPart(` 부곡${attackerId} 대 `),
        generalPart(state.generals[defenderCommander]!),
        textPart(` 부곡${defenderId}: 공격 `),
        numPart(a.troops),
        textPart('명, 수비 '),
        numPart(d.troops),
        textPart('명'),
      ];
      rounds.push(parts);
      // BattleLog의 (worldId,tick,attackerId,generalId) 키당 한 행으로 저장한다.
      const report = reports.find((row) => row.generalId === defenderCommander);
      if (report) {
        report.parts!.push(textPart('; '), ...parts);
        report.text = logPartsToText(report.parts!);
      } else
        reports.push({
          generalId: defenderCommander,
          defenderId: defenderCommander,
          cityKey,
          ...logSentence([...parts]),
        });
      if (alive(d)) break;
    }
    if (defendingIds.some((id) => alive(get(id)))) continue;
    for (const crewType of cityDefense()
      .map((row) => row.crewType)
      .sort((a, b) => a - b)) {
      if (!alive(get(attackerId))) break;
      const outcome = fightCampaignCityGarrison(
        state,
        attackerId,
        cityKey,
        crewType,
        actor.unitSet!,
        rng,
        attackerFirstVolleyUsed,
      );
      state = outcome.state;
      attackerFirstVolleyUsed ||= outcome.attackerFirstVolleyFired === true;
      rounds.push([textPart(outcome.text)]);
      if (cityDefense().some((row) => row.crewType === crewType && row.troops > 0 && row.atmos > 0)) break;
    }
    if (cityDefense().some((row) => row.troops > 0 && row.atmos > 0)) continue;
    // 기존 출병은 벽이 0이어도 점령 직전 군량을 한 번 소비한다.
    if (alive(get(attackerId)) && (!wallFirst || state.cities[cityKey]!.wall > 0)) fightWall();
    if (state.cities[cityKey]!.wall === 0 && alive(get(attackerId))) break;
  }
  const captured =
    !defendingIds.some((id) => alive(get(id))) &&
    !cityDefense().some((row) => row.troops > 0 && row.atmos > 0) &&
    state.cities[cityKey]!.wall === 0 &&
    attackingIds.some((id) => alive(get(id)));
  const history: NonNullable<CommandResult['history']> = [];
  if (captured) {
    {
      const outcome = disbandCityGarrison(state, cityKey);
      state = outcome.state;
      rounds.push([textPart(outcome.text)]);
    }
    battleAwards.push({ generalId: ownerId, wins: 0, captures: 1 });
    const city = state.cities[cityKey]!;
    city.nationId = nationId;
    captureCounties(state, city.cityKey);
    city.defence = 0;
    city.security = Math.round(city.security * BALANCE.CAPTURE_SECURITY_FACTOR);
    city.trust = Math.max(0, city.trust - BALANCE.CAPTURE_TRUST_LOSS);
    state.generals[ownerId]!.cityKey = cityKey;
    if (defendingNation !== null) {
      const nation = state.nations[defendingNation]!;
      const remaining = Object.values(state.cities)
        .filter((row) => row.nationId === defendingNation && row.kind !== 'PASS' && row.kind !== 'FIELD')
        .sort((a, b) => b.population - a.population || a.cityKey - b.cityKey);
      if (!remaining.length) {
        {
          for (const neutralized of Object.values(state.cities).filter((row) => row.nationId === defendingNation)) {
            const ended = disbandCityGarrison(state, neutralized.cityKey);
            state = ended.state;
            if (ended.troops) rounds.push([textPart(ended.text)]);
          }
        }
        removeNation(state, defendingNation);
        history.push({
          nationId: defendingNation,
          ...logSentence([nationPart(nation), textPart(' 멸망, 소속 장수 재야')]),
        });
      } else if (nation.capitalCityKey === cityKey) {
        nation.capitalCityKey = remaining[0]!.cityKey;
        history.push({
          nationId: defendingNation,
          ...logSentence([nationPart(nation), textPart(' 수도 함락, '), cityPart(remaining[0]!), textPart(' 천도')]),
        });
      }
    }
    refreshSupply(state);
    state = followCampaignCommanders(view, state);
  }
  const troops = attackingIds.reduce((sum, id) => sum + get(id).troops, 0);
  const summaryParts: LogPart[] = [
    generalPart(state.generals[ownerId]!),
    textPart(' '),
    cityPart(state.cities[cityKey]!),
    textPart(` ${captured ? '점령' : '점령 실패'}: 병력 `),
    numPart(troops),
    textPart('명'),
  ];

  for (const report of reports) {
    report.parts!.push(textPart(`, ${captured ? '점령' : '수비 유지'}`));
    report.text = logPartsToText(report.parts!);
  }
  history.push({ nationId, ...logSentence([...rounds.flatMap((line) => [...line, textPart('; ')]), ...summaryParts]) });
  if (defendingNation !== null) history.push({ nationId: defendingNation, ...logSentence(summaryParts) });
  state.campaign!.units = state.campaign!.units.filter((unit) => unit.troops > 0);
  readCampaignState(state.campaign, state);
  return {
    logs: [...rounds, summaryParts].map((parts) => commandLog(parts)),
    effects: [{ kind: 'world', state }],
    reports,
    history,
    battleAwards,
    attackTarget: { cityKey, defendingNationId: defendingNation },
    ...{ battleOutcomes },
  };
}

// 엔진 저장과 재생 결과의 대조가 같은 정산 경계와 참여자를 사용한다.
export function tacticalBattleReports(
  before: WorldView,
  after: WorldView,
  battleId: string,
  tick: number,
  cancelled = false,
): CommandResult {
  const result: CommandResult = { ...success(''), effects: [], reports: [], battleAwards: [], history: [] };
  const old = before.campaign?.tactical?.battles.find((b) => b.id === battleId);
  const battle = after.campaign?.tactical?.battles.find((b) => b.id === battleId);
  if (!old || old.settled || !battle?.settled || battle.fault) return result;
  const attackerId = battle.units.find((u) => u.side === 'attack' && u.ownerId !== null)?.ownerId;
  if (attackerId == null) return result;
  const target = before.cities[battle.targetCityKey]!;
  const captured =
    battle.result === 'attack' && after.cities[target.cityKey]?.nationId === battle.sides.attack.nationId;
  const summary = `${before.generals[attackerId]!.name} ${target.name} ${captured ? '점령' : '점령 실패'}: ${battle.reason ?? ''}`;
  const defenders = [
    ...new Set(battle.units.filter((u) => u.side === 'defend' && u.commanderId !== null).map((u) => u.commanderId!)),
  ];
  for (const generalId of defenders)
    result.reports!.push({
      generalId,
      text: `${summary}; ${battle.units.map((u) => `${u.sourceId === null ? '수비병' : `부곡${u.sourceId}`} ${u.troops}명`).join('; ')}`,
    });
  // 재생이 기록하는 승패·점령 사건과 같은 계산을 전공 저장에도 쓴다.
  for (const event of reputationBattleEvents(before, after, tick, cancelled ? battleId : undefined)) {
    if (event.data.city?.cityKey !== target.cityKey) continue;
    if (event.kind === 'victory') result.battleAwards!.push({ generalId: event.generalId, wins: 1, captures: 0 });
    if (event.kind === 'conquest') result.battleAwards!.push({ generalId: attackerId, wins: 0, captures: 1 });
  }
  for (const nationId of new Set([battle.sides.attack.nationId, battle.sides.defend.nationId])) {
    if (nationId === null) continue;
    const destroyed = before.nations[nationId] && !after.nations[nationId];
    result.history!.push({
      nationId,
      text: destroyed ? `${before.nations[nationId]!.name} 멸망, 소속 장수 재야; ${summary}` : summary,
    });
  }
  return result;
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
