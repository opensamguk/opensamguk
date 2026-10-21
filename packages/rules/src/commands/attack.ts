import { z } from 'zod';
import type { Rng } from '@opensamguk/shared';
import { BALANCE } from '../balance';
import type { Actor } from './types';
import type { InitialGeneral } from '../world/bootstrap';
import type { DeepReadonly } from '../model/world';
import type { UnitSetResource } from '../world/resources';
import { refreshSupply } from '../supply';
import { defineCommand, fail, positive, relation, removeNation, success } from './support';

type Unit = DeepReadonly<UnitSetResource['crewTypes'][number]>;
type Force = Pick<InitialGeneral, 'crew' | 'crewType' | 'train' | 'atmos' | 'rice'>;
function unit(actor: Actor, id: number): Unit {
  const result = actor.unitSet?.crewTypes.find((u) => u.id === id);
  if (!result) throw new Error('전투 병종이 없습니다.');
  return result;
}
function coefficient(table: Unit['attackCoef'], arm: number) {
  return Array.isArray(table) ? 1 : ((table as Readonly<Record<string, number>>)[String(arm)] ?? 1);
}
function damage(a: Force, b: Force, actor: Actor, rng: Rng, tech: number, defence: number) {
  const attacking = unit(actor, a.crewType),
    defending = unit(actor, b.crewType);
  const power =
    ((a.crew *
      (attacking.attack / Math.max(1, defending.defence + defence)) *
      coefficient(attacking.attackCoef, defending.armType)) /
      Math.max(0.01, coefficient(defending.defenceCoef, attacking.armType))) *
    ((50 + a.train) / 150) *
    ((50 + a.atmos) / 150) *
    (1 + tech / BALANCE.MAX_TECH) *
    BALANCE.DAMAGE_FACTOR *
    (0.9 + rng.next() * 0.2);
  return Math.min(b.crew, Math.max(1, Math.round(power)));
}
function fight(a: Force, b: Force, actor: Actor, rng: Rng, aTech: number, bTech: number, defence = 0) {
  for (
    let phase = 0;
    phase < BALANCE.BATTLE_PHASES && a.crew > 0 && b.crew > 0 && a.atmos > 0 && b.atmos > 0;
    phase++
  ) {
    // 양쪽 피해는 같은 페이즈 시작 상태로 계산하고 동시에 적용한다.
    const toB = damage(a, b, actor, rng, aTech, defence),
      toA = damage(b, a, actor, rng, bTech, 0);
    a.crew -= toA;
    b.crew -= toB;
    a.atmos = Math.max(0, a.atmos - BALANCE.BATTLE_ATMOS_LOSS);
    b.atmos = Math.max(0, b.atmos - BALANCE.BATTLE_ATMOS_LOSS);
  }
}
function feed(force: Force) {
  force.rice = Math.max(0, force.rice - Math.ceil(force.crew * BALANCE.BATTLE_RICE_PER_CREW));
  if (force.rice === 0) force.atmos = Math.max(0, force.atmos - BALANCE.STARVATION_ATMOS_LOSS);
}
export const attack = defineCommand({
  key: 'attack',
  name: '출병',
  category: 'military',
  args: z.strictObject({ cityKey: positive }),
  check(view, actor, args) {
    const g = view.generals[actor.generalId]!;
    if (g.nationId === null) return fail('NOT_NATION', '국가에 소속되어야 합니다.');
    const from = view.cities[g.cityKey],
      target = view.cities[args.cityKey];
    if (!target || target.nationId === g.nationId) return fail('BAD_TARGET', '자기 국가 도시에는 출병할 수 없습니다.');
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
          d.crew > 0 &&
          d.train >= BALANCE.DEFEND_TRAIN &&
          d.atmos >= BALANCE.DEFEND_ATMOS &&
          d.activeFromYear <= state.startYear + Math.floor((actor.tick ?? 0) / (12 * 10000)),
      )
      .sort((a, b) => b.crew - a.crew || a.id - b.id);
    const reports: { generalId: number; text: string }[] = [];
    const rounds: string[] = [];
    let cleared = true;
    for (const defender of defenders) {
      feed(g);
      feed(defender);
      fight(g, defender, actor, rng, aTech, bTech);
      const text = `${g.name} 대 ${defender.name}: 공격 ${g.crew}명, 수비 ${defender.crew}명`;
      rounds.push(text);
      reports.push({ generalId: defender.id, text });
      if (g.crew <= 0 || g.atmos <= 0 || (defender.crew > 0 && defender.atmos > 0)) {
        cleared = false;
        break;
      }
    }
    if (cleared && g.crew > 0 && g.atmos > 0) {
      const wall: Force = { crew: city.wall, crewType: 1000, train: 100, atmos: 100, rice: 0 };
      feed(g);
      fight(g, wall, actor, rng, aTech, bTech, city.defence);
      city.wall = wall.crew;
      rounds.push(`성벽 교전: 공격 ${g.crew}명, 성벽 ${city.wall}`);
    }
    const captured = cleared && city.wall === 0 && g.crew > 0 && g.atmos > 0;
    const history: { nationId: number; text: string }[] = [];
    if (captured) {
      city.nationId = attackingNation;
      city.defence = 0;
      city.security = Math.round(city.security * BALANCE.CAPTURE_SECURITY_FACTOR);
      city.trust = Math.max(0, city.trust - BALANCE.CAPTURE_TRUST_LOSS);
      g.cityKey = city.cityKey;
      let relocated: { nationId: number; text: string } | undefined;
      if (defendingNation !== null) {
        const nation = state.nations[defendingNation]!;
        const remaining = Object.values(state.cities)
          .filter((c) => c.nationId === defendingNation)
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
    history.push({ nationId: attackingNation, text: `${rounds.join('; ')}; ${summary}` });
    if (defendingNation !== null) history.push({ nationId: defendingNation, text: summary });
    return { ...success(`${rounds.join('\n')}\n${summary}`), reports, history };
  },
});
