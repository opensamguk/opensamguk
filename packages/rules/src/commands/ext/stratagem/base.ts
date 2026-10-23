// core2026 df6c926 packages/logic/src/actions/turn/general/strategyCommand.ts의 계략 확률·피해 공식을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { z } from 'zod';
import { toGameDate } from '../../../clock/clock';
import type { WorldView } from '../../../model/world';
import type { InitialGeneral } from '../../../world/bootstrap';
import type { CityField, Effect } from '../../effects';
import { fail, ownCity, positive, relation } from '../../support';
import type { Actor, CommandDef, CommandResult, Failure } from '../../types';

// S1: 연도와 무관하게 금·쌀 각 100. S2: 부상으로 능력치를 줄이지 않는다.
// S3: 부상 80 이상은 유지. S4: 불탐 표시·성공 횟수·별도 능력치 경험은 생략한다.
// S5: 탈취는 보급과 무관하게 대상 재고에서 뺀다. S6: 장비·특기 보정은 없다.
// S7: 장수 로그·다친 장수 보고·대상 국가 기록. 판정은 확률 0·0.5에도 next 한 번이다.
export const STRATAGEM = {
  COST_GOLD: 100,
  COST_RICE: 100,
  BASE_PROBABILITY: 0.35,
  STAT_COEFFICIENT: 300,
  MAX_STAT: 255,
  MAX_PROBABILITY: 0.5,
  INJURY_PROBABILITY: 0.3,
  INJURY_MAX: 80,
  DAMAGE_MIN: 100,
  DAMAGE_MAX: 800,
} as const;

type Stat = 'leadership' | 'strength' | 'intel';
type General = WorldView['generals'][number];
type Spec = {
  key: string;
  name: string;
  stat: Stat;
  fields?: readonly [CityField, CityField];
  labels?: readonly [string, string];
};
const argsSchema = z.strictObject({ cityKey: positive });

export function effectiveStat(general: Pick<InitialGeneral, Stat>, stat: Stat): number {
  const cross = stat === 'strength' ? general.intel : stat === 'intel' ? general.strength : 0;
  return Math.trunc(Math.max(0, Math.min(STRATAGEM.MAX_STAT, general[stat] + Math.round(cross / 4))));
}

export function stratagemDistance(view: WorldView, from: number, to: number): number {
  const seen = new Set([from]);
  let frontier = [from];
  for (let distance = 1; distance <= 5; distance++) {
    const next: number[] = [];
    for (const key of frontier) {
      for (const neighbor of view.cities[key]?.connections ?? []) {
        if (seen.has(neighbor) || !view.cities[neighbor]) continue;
        if (neighbor === to) return distance;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return 99;
}

export function stratagemDefenders(view: WorldView, cityKey: number, year: number): General[] {
  return Object.values(view.generals)
    .filter((g) => g.cityKey === cityKey && g.nationId === view.cities[cityKey]!.nationId && g.activeFromYear <= year)
    .sort((a, b) => a.id - b.id);
}

export function stratagemProbability(view: WorldView, actor: Actor, cityKey: number, stat: Stat): number {
  const general = view.generals[actor.generalId]!;
  const city = view.cities[cityKey]!;
  const year = toGameDate(view.startYear, actor.tick ?? 0).year;
  const defenders = stratagemDefenders(view, cityKey, year);
  const attack = effectiveStat(general, stat) / STRATAGEM.STAT_COEFFICIENT;
  const defence =
    Math.max(0, ...defenders.map((g) => effectiveStat(g, stat))) / STRATAGEM.STAT_COEFFICIENT +
    (Math.log2(defenders.length + 1) - 1.25) * 0.04 +
    city.security / city.securityMax / 5 +
    (city.supplied ? 0.1 : 0);
  return Math.min(
    STRATAGEM.MAX_PROBABILITY,
    Math.max(0, (STRATAGEM.BASE_PROBABILITY + attack - defence) / stratagemDistance(view, general.cityKey, cityKey)),
  );
}

export function plunderYearCoefficient(startYear: number, year: number): number {
  return Math.sqrt(1 + Math.max(0, year - startYear) / 4) / 2;
}

function check(view: WorldView, actor: Actor, raw: unknown): Failure | null {
  const failure = ownCity(view, actor);
  if (failure) return failure;
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) return fail('BAD_ARGS', '명령 인자가 잘못되었습니다.');
  const general = view.generals[actor.generalId]!;
  const city = view.cities[parsed.data.cityKey];
  if (!city) return fail('BAD_TARGET', '없는 도시입니다.');
  if (city.nationId === general.nationId) return fail('BAD_TARGET', '자기 국가 도시에는 계략을 쓸 수 없습니다.');
  if (city.nationId === null) return fail('BAD_TARGET', '공백지에는 계략을 쓸 수 없습니다.');
  if (relation(view, general.nationId!, city.nationId)?.state === 'NON_AGGRESSION')
    return fail('BAD_TARGET', '불가침 중인 국가입니다.');
  if (general.gold < STRATAGEM.COST_GOLD) return fail('NO_GOLD', '금이 부족합니다.');
  if (general.rice < STRATAGEM.COST_RICE) return fail('NO_RICE', '쌀이 부족합니다.');
  return null;
}

export function makeStratagem(spec: Spec): CommandDef {
  return {
    key: spec.key,
    name: spec.name,
    category: 'strategy',
    target: 'general',
    args: argsSchema,
    check,
    precheck: check,
    execute(view, actor, raw, rng) {
      const failure = check(view, actor, raw);
      if (failure) throw new Error(failure.message);
      const { cityKey } = argsSchema.parse(raw);
      const general = view.generals[actor.generalId]!;
      const city = view.cities[cityKey]!;
      const year = toGameDate(view.startYear, actor.tick ?? 0).year;
      const success = rng.next() < stratagemProbability(view, actor, cityKey, spec.stat);
      const injuries: Effect[] = [];
      const reports: NonNullable<CommandResult['reports']> = [];
      if (success && spec.fields) {
        for (const defender of stratagemDefenders(view, cityKey, year)) {
          if (rng.next() >= STRATAGEM.INJURY_PROBABILITY) continue;
          // 80 이상도 같은 난수를 소비해 뒤의 피해·성장 스트림을 보존한다.
          const injury = rng.int(1, 16);
          if (defender.injury < STRATAGEM.INJURY_MAX)
            injuries.push({
              kind: 'general',
              id: defender.id,
              field: 'injury',
              op: 'set',
              value: Math.min(80, defender.injury + injury),
            });
          for (const field of ['crew', 'atmos', 'train'] as const)
            injuries.push({
              kind: 'general',
              id: defender.id,
              field,
              op: 'set',
              value: Math.round(defender[field] * 0.98),
            });
          reports.push({ generalId: defender.id, text: `${city.name}: 계략으로 다쳤습니다.` });
        }
      }
      const damage: Effect[] = [];
      let primary = 0;
      let secondary = 0;
      if (success) {
        primary = rng.int(STRATAGEM.DAMAGE_MIN, STRATAGEM.DAMAGE_MAX);
        secondary =
          spec.key === 'incite' ? (100 + rng.next() * 700) / 50 : rng.int(STRATAGEM.DAMAGE_MIN, STRATAGEM.DAMAGE_MAX);
        if (spec.fields) {
          primary = Math.min(primary, city[spec.fields[0]]);
          secondary = Math.min(secondary, city[spec.fields[1]]);
          damage.push(
            { kind: 'city', id: cityKey, field: spec.fields[0], op: 'add', value: -primary },
            { kind: 'city', id: cityKey, field: spec.fields[1], op: 'add', value: -secondary },
          );
        } else {
          const targetNation = view.nations[city.nationId!]!;
          const coefficient = city.level * plunderYearCoefficient(view.startYear, year);
          primary = Math.min(
            primary * coefficient * (0.25 + city.commerce / city.commerceMax / 4),
            Math.max(0, targetNation.gold),
          );
          secondary = Math.min(
            secondary * coefficient * (0.25 + city.agriculture / city.agricultureMax / 4),
            Math.max(0, targetNation.rice),
          );
          // 정수 자원 효과의 .5 반올림으로 자원이 늘지 않도록 총량을 먼저 고정한다.
          primary = Math.round(primary);
          secondary = Math.round(secondary);
          const goldShare = Math.round(primary * 0.7);
          const riceShare = Math.round(secondary * 0.7);
          damage.push(
            { kind: 'nation', id: targetNation.id, field: 'gold', op: 'add', value: -primary },
            { kind: 'nation', id: targetNation.id, field: 'rice', op: 'add', value: -secondary },
            { kind: 'nation', id: general.nationId!, field: 'gold', op: 'add', value: goldShare },
            { kind: 'nation', id: general.nationId!, field: 'rice', op: 'add', value: riceShare },
            { kind: 'general', id: general.id, field: 'gold', op: 'add', value: primary - goldShare },
            { kind: 'general', id: general.id, field: 'rice', op: 'add', value: secondary - riceShare },
          );
        }
      }
      const experience = success ? rng.int(201, 300) : rng.int(1, 100);
      const dedication = success ? rng.int(141, 210) : rng.int(1, 70);
      const effects: Effect[] = [
        { kind: 'general', id: general.id, field: 'gold', op: 'add', value: -STRATAGEM.COST_GOLD },
        { kind: 'general', id: general.id, field: 'rice', op: 'add', value: -STRATAGEM.COST_RICE },
        { kind: 'general', id: general.id, field: 'experience', op: 'add', value: experience },
        { kind: 'general', id: general.id, field: 'dedication', op: 'add', value: dedication },
        ...injuries,
        ...damage,
      ];
      if (!success) return { effects, logs: [{ kind: 'success', text: `${spec.name} 실패: ${city.name}` }] };
      const amounts = spec.fields
        ? `${spec.labels![0]} ${primary}, ${spec.labels![1]} ${spec.key === 'incite' ? secondary.toFixed(1) : secondary} 감소`
        : `금 ${Math.round(primary)}, 쌀 ${Math.round(secondary)}`;
      return {
        effects,
        logs: [
          {
            kind: 'success',
            text: `${spec.name} 성공: ${city.name} ${amounts}${spec.fields ? `, 장수 ${reports.length}명 부상` : ' 획득'}`,
          },
        ],
        ...(spec.fields ? { reports } : {}),
        history: [
          {
            nationId: city.nationId!,
            text: spec.fields
              ? `${city.name}: ${spec.name}${spec.key === 'incite' ? '으로' : '로'} ${amounts}`
              : `${city.name}: ${amounts} 도난`,
          },
        ],
      };
    },
  };
}
