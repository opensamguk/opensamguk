import { TICKS_PER_MONTH } from '../clock/constants';
import { z } from 'zod';
import { nationRestrictions } from '../personnel/nationRestrictions';
import { addGeneralProficiency } from '../general/proficiency';
import { personalityEffects } from '../general/personality';
import { BALANCE } from '../balance';
import { simulateBattle, type BattlePhase } from '../battle/simulate';
import { canDefend, DEFENSE_STANCE_FEATURE } from '../battle/defenders';
import type { CommandResult } from './types';
import type { InitialGeneral } from '../world/bootstrap';
import { refreshSupply } from '../supply';
import { defineCommand, fail, positive, relation, removeNation, success } from './support';
import { collectModifiers, collectModifiersWith, type ModifierProvider } from '../modifiers';

type Force = Pick<InitialGeneral, 'crew' | 'crewType' | 'train' | 'atmos' | 'rice'>;
function feed(force: Force) {
  force.rice = Math.max(0, force.rice - Math.ceil(force.crew * BALANCE.BATTLE_RICE_PER_CREW));
  if (force.rice === 0) force.atmos = Math.max(0, force.atmos - BALANCE.STARVATION_ATMOS_LOSS);
}
export const attack = makeAttack(collectModifiers);

export function createAttackWithProviders(providers: readonly ModifierProvider[]) {
  return makeAttack((view, generalId, context) => collectModifiersWith(providers, view, generalId, context));
}

function makeAttack(collect: typeof collectModifiers) {
  return defineCommand({
    key: 'attack',
    name: '출병',
    category: 'military',
    args: z.strictObject({ cityKey: positive }),
    check(view, actor, args) {
      if (Math.floor((actor.tick ?? 0) / TICKS_PER_MONTH) < (view.presetRules?.protection.peaceMonths ?? 0))
        return fail('PROTECTED', '초반 보호 기간에는 출병할 수 없습니다.');
      const g = view.generals[actor.generalId]!;
      if (g.nationId === null) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
      if (nationRestrictions(view, view.nations[g.nationId]).warBlocked)
        return fail('PROTECTED', '국가가 출병을 금지했습니다.');
      const from = view.cities[g.cityKey],
        target = view.cities[args.cityKey];
      if (!target || target.nationId === g.nationId)
        return fail('BAD_TARGET', '자기 국가 도시에는 출병할 수 없습니다.');
      if (from?.nationId !== g.nationId) return fail('NOT_OWN_CITY', '자기 국가 도시에서 출병해야 합니다.');
      if (!from.supplied) return fail('NO_SUPPLY', '보급이 끊긴 도시입니다.');
      if (!from.connections.includes(target.cityKey)) return fail('NOT_ADJACENT', '연결된 도시가 아닙니다.');
      if (target.nationId !== null && relation(view, g.nationId, target.nationId)?.state !== 'WAR')
        return fail('NOT_WAR', '교전 중인 국가가 아닙니다.');
      if (g.crew <= 0 || g.atmos <= 0) return fail('NO_CREW', '출병할 병력이나 사기가 부족합니다.');
      if (!actor.unitSet?.crewTypes.some((u) => u.id === 1000)) return fail('NO_UNIT_SET', '성벽 병종이 없습니다.');
      const forces = [
        g,
        ...Object.values(view.generals).filter(
          (d) => d.cityKey === target.cityKey && d.nationId === target.nationId && d.crew > 0,
        ),
      ];
      return forces.every((d) => actor.unitSet!.crewTypes.some((u) => u.id === d.crewType))
        ? null
        : fail('NO_UNIT_SET', '전투 병종이 없습니다.');
    },
    change(state, actor, args, rng) {
      const g = state.generals[actor.generalId]!,
        city = state.cities[args.cityKey]!;
      const attackingNation = g.nationId!,
        defendingNation = city.nationId;
      const aTech = state.nations[attackingNation]!.tech,
        bTech = defendingNation === null ? 0 : state.nations[defendingNation]!.tech;
      const defenders = Object.values(state.generals)
        .filter(
          (d) =>
            defendingNation !== null &&
            d.nationId === defendingNation &&
            d.cityKey === city.cityKey &&
            canDefend(
              d.crew,
              d.train,
              d.atmos,
              state.ruleFeatures?.includes(DEFENSE_STANCE_FEATURE),
              d.defenseThreshold,
            ) &&
            d.activeFromYear <= state.startYear + Math.floor((actor.tick ?? 0) / (12 * 10000)),
        )
        .sort((a, b) => b.crew - a.crew || a.id - b.id);
      const reports: NonNullable<CommandResult['reports']> = [];
      const battleAwards: NonNullable<CommandResult['battleAwards']> = [];
      const battleOutcomes: NonNullable<CommandResult['battleOutcomes']> = [];
      const generalEngagements: NonNullable<CommandResult['generalEngagements']> = [];
      const reputation = state.ruleFeatures?.includes('reputation-v1');
      const rounds: string[] = [];
      const attackPhases: BattlePhase[] = [];
      let attackerFirstVolleyUsed = false;
      const wallFirst =
        defenders.length > 0 &&
        city.wall > 0 &&
        actor.unitSet!.crewTypes.find((unit) => unit.id === g.crewType)?.effects?.includes('wallFirst');
      const fightWall = (openingSkirmish = false) => {
        const wall: Force = { crew: city.wall, crewType: 1000, train: 100, atmos: 100, rice: 0 };
        feed(g);
        const battle = simulateBattle(
          {
            attacker: g,
            attackerReadiness: personalityEffects(state, g.personality),
            attackerProficiency: g.proficiency,
            defender: wall,
            recordPhases: actor.recordBattleStats === true,
            attackerTech: aTech,
            defenderTech: bTech,
            defence: city.defence,
            openingSkirmish,
            siege: !openingSkirmish,
            attackerFirstVolleyUsed,
            unitSet: actor.unitSet!,
            coefMode: state.ruleFeatures?.includes('battle-affinity-v2') ? 'multiply' : 'divide',
            attackerModifiers: {
              dealt: collect(state, g.id, { stage: 'battle.dealt', commandKey: 'attack' }),
              taken: collect(state, g.id, { stage: 'battle.taken', commandKey: 'attack' }),
            },
          },
          rng,
        );
        attackerFirstVolleyUsed ||= battle.attackerFirstVolleyFired === true;
        Object.assign(g, battle.attacker);
        addGeneralProficiency(state, g, 5, city.wall - battle.defender.crew);
        city.wall = battle.defender.crew;
        const name = openingSkirmish ? '성벽 선제 교전' : '성벽 교전';
        for (const phase of battle.phases ?? []) attackPhases.push({ ...phase, opponent: '성벽' });
        rounds.push(`${name}: 공격 ${g.crew}명, 성벽 ${city.wall}`);
      };
      if (wallFirst) fightWall(true);
      let cleared = g.crew > 0 && g.atmos > 0;
      for (const defender of cleared ? defenders : []) {
        feed(g);
        feed(defender);
        const battle = simulateBattle(
          {
            attacker: g,
            attackerReadiness: personalityEffects(state, g.personality),
            attackerProficiency: g.proficiency,
            defender,
            defenderReadiness: personalityEffects(state, defender.personality),
            defenderProficiency: defender.proficiency,
            recordPhases: actor.recordBattleStats === true,
            attackerTech: aTech,
            defenderTech: bTech,
            attackerFirstVolleyUsed,
            unitSet: actor.unitSet!,
            coefMode: state.ruleFeatures?.includes('battle-affinity-v2') ? 'multiply' : 'divide',
            attackerModifiers: {
              dealt: collect(state, g.id, { stage: 'battle.dealt', commandKey: 'attack' }),
              taken: collect(state, g.id, { stage: 'battle.taken', commandKey: 'attack' }),
            },
            defenderModifiers: {
              dealt: collect(state, defender.id, { stage: 'battle.dealt', commandKey: 'attack' }),
              taken: collect(state, defender.id, { stage: 'battle.taken', commandKey: 'attack' }),
            },
          },
          rng,
        );
        attackerFirstVolleyUsed ||= battle.attackerFirstVolleyFired === true;
        const attackerLoss = g.crew - battle.attacker.crew;
        const defenderLoss = defender.crew - battle.defender.crew;
        const arms = actor.unitSet!.crewTypes;
        addGeneralProficiency(state, g, arms.find((type) => type.id === g.crewType)!.armType, defenderLoss);
        addGeneralProficiency(
          state,
          defender,
          arms.find((type) => type.id === defender.crewType)!.armType,
          attackerLoss * 0.8,
        );
        Object.assign(g, battle.attacker);
        Object.assign(defender, battle.defender);
        const attackerSurvives = g.crew > 0 && g.atmos > 0;
        const defenderSurvives = defender.crew > 0 && defender.atmos > 0;
        generalEngagements.push({
          attackerId: g.id,
          defenderId: defender.id,
          attackerLoss,
          defenderLoss,
          winnerId: attackerSurvives === defenderSurvives ? null : attackerSurvives ? g.id : defender.id,
        });
        if (attackerSurvives && !defenderSurvives) {
          battleAwards.push({ generalId: g.id, wins: 1, captures: 0 });
          if (reputation) battleOutcomes.push({ winnerId: g.id, loserId: defender.id });
        } else if (!attackerSurvives && defenderSurvives) {
          battleAwards.push({ generalId: defender.id, wins: 1, captures: 0 });
          if (reputation) battleOutcomes.push({ winnerId: defender.id, loserId: g.id });
        }
        const text = `${g.name} 대 ${defender.name}: 공격 ${g.crew}명, 수비 ${defender.crew}명`;
        rounds.push(text);
        for (const phase of battle.phases ?? []) attackPhases.push({ ...phase, opponent: defender.name });
        reports.push({ generalId: defender.id, text, ...(battle.phases?.length ? { phases: battle.phases } : {}) });
        if (g.crew <= 0 || g.atmos <= 0 || (defender.crew > 0 && defender.atmos > 0)) {
          cleared = false;
          break;
        }
      }
      if (cleared && (!wallFirst || city.wall > 0)) fightWall();
      const captured = cleared && city.wall === 0 && g.crew > 0 && g.atmos > 0;
      const history: { nationId: number; text: string }[] = [];
      if (captured) {
        battleAwards.push({ generalId: g.id, wins: 0, captures: 1 });
        city.nationId = attackingNation;
        city.defence = 0;
        city.security = Math.round(city.security * BALANCE.CAPTURE_SECURITY_FACTOR);
        city.trust = Math.max(0, city.trust - BALANCE.CAPTURE_TRUST_LOSS);
        g.cityKey = city.cityKey;
        let relocated: { nationId: number; text: string } | undefined;
        if (defendingNation !== null) {
          const nation = state.nations[defendingNation]!;
          const remaining = Object.values(state.cities)
            .filter((c) => c.nationId === defendingNation && c.kind !== 'PASS')
            .sort((a, b) => b.population - a.population || a.cityKey - b.cityKey);
          if (!remaining.length) {
            removeNation(state, defendingNation);
            history.push({ nationId: defendingNation, text: `${nation.name} 멸망, 소속 장수 재야` });
          } else if (nation.capitalCityKey === city.cityKey) {
            const capital = remaining[0]!;
            nation.capitalCityKey = capital.cityKey;
            relocated = { nationId: defendingNation, text: `${nation.name} 수도 함락, ${capital.name} 천도` };
          }
        }
        refreshSupply(state);
        if (relocated) history.push(relocated);
      }
      const summary = `${g.name} ${city.name} ${captured ? '점령' : '점령 실패'}: 병력 ${g.crew}명`;
      for (const report of reports) report.text += `, ${captured ? '점령' : '수비 유지'}`;
      if (actor.recordBattleStats)
        reports.push({ generalId: g.id, text: summary, ...(attackPhases.length ? { phases: attackPhases } : {}) });
      history.push({ nationId: attackingNation, text: `${rounds.join('; ')}; ${summary}` });
      if (defendingNation !== null) history.push({ nationId: defendingNation, text: summary });
      return {
        ...success(`${rounds.join('\n')}\n${summary}`),
        reports,
        history,
        battleAwards,
        ...(actor.recordBattleStats ? { generalEngagements } : {}),
        ...(reputation ? { battleOutcomes } : {}),
        attackTarget: { cityKey: args.cityKey, defendingNationId: defendingNation },
      };
    },
  });
}
