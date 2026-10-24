// core2026 df6c926 packages/logic/src/actions/turn/general/che_첩보.ts의 거리 단계와 정보 항목을 옮겼다.
// MIT (c) 2025 devsam. resources/NOTICE.md.
import { z } from 'zod';
import { toGameDate } from '../../../clock/clock';
import type { WorldView } from '../../../model/world';
import { fail, positive } from '../../support';
import type { Actor, Failure } from '../../types';
import type { IntelRecord, IntelTech } from './record';

// I1: 연도와 무관하게 금·쌀 각 60. I2: 대상 국가에 실행 국가를 밝히지 않고 알린다.
// I3: 원작의 기술 비교 다섯 단계를 쓴다. I4: 재야는 거부한다.
// 통솔 경험, 지도 실시간 열람과 월간 감소, 전체 공지는 옮기지 않는다.
export const INTEL = { COST_GOLD: 60, COST_RICE: 60 } as const;
export const spyArgs = z.strictObject({ cityKey: positive });

export function intelDistance(view: WorldView, from: number, to: number): number {
  if (from === to) return 0;
  const seen = new Set([from]);
  let frontier = [from];
  for (let distance = 1; distance <= 2; distance++) {
    const next: number[] = [];
    for (const cityKey of frontier) {
      for (const neighbor of view.cities[cityKey]?.connections ?? []) {
        if (seen.has(neighbor) || !view.cities[neighbor]) continue;
        if (neighbor === to) return distance;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return 3;
}

export function intelLevel(distance: number): 1 | 2 | 3 {
  return distance <= 1 ? 1 : distance === 2 ? 2 : 3;
}

export function techCompare(targetTech: number, ownTech: number): IntelTech {
  const diff = Math.floor(targetTech) - Math.floor(ownTech);
  if (diff >= 1000) return 'overwhelming';
  if (diff >= 250) return 'ahead';
  if (diff >= -250) return 'even';
  if (diff >= -1000) return 'behind';
  return 'far_behind';
}

export function checkSpy(view: WorldView, actor: Actor, raw: unknown): Failure | null {
  const general = view.generals[actor.generalId];
  if (!general) return fail('NO_ACTOR', '장수가 없습니다.');
  if (general.nationId === null || !view.nations[general.nationId])
    return fail('NOT_NATION', '국가에 소속되어야 합니다.');
  const parsed = spyArgs.safeParse(raw);
  if (!parsed.success) return fail('BAD_ARGS', '명령 인자가 잘못되었습니다.');
  const city = view.cities[parsed.data.cityKey];
  if (!city) return fail('BAD_TARGET', '없는 도시입니다.');
  if (city.nationId === general.nationId) return fail('BAD_TARGET', '자기 국가 도시는 첩보할 수 없습니다.');
  if (general.gold < INTEL.COST_GOLD) return fail('NO_GOLD', '금이 부족합니다.');
  if (general.rice < INTEL.COST_RICE) return fail('NO_RICE', '쌀이 부족합니다.');
  return null;
}

export function buildIntelRecord(view: WorldView, actor: Actor, cityKey: number): IntelRecord {
  const general = view.generals[actor.generalId]!;
  const city = view.cities[cityKey]!;
  const level = intelLevel(intelDistance(view, general.cityKey, cityKey));
  const tick = actor.tick ?? 0;
  const year = toGameDate(view.startYear, tick).year;
  const generals = Object.values(view.generals)
    .filter((g) => g.cityKey === cityKey && g.nationId === city.nationId && g.activeFromYear <= year)
    .sort((a, b) => a.id - b.id);
  const nation = city.nationId === null ? null : view.nations[city.nationId]!;
  const record: IntelRecord = {
    tick,
    level,
    owner: nation ? { id: nation.id, name: nation.name, color: nation.color } : null,
    population: city.population,
    populationMax: city.populationMax,
    trust: city.trust,
    generals: generals.length,
    crew: generals.reduce((sum, g) => sum + g.crew, 0),
  };
  if (level <= 2) {
    record.domestic = {
      agriculture: city.agriculture,
      agricultureMax: city.agricultureMax,
      commerce: city.commerce,
      commerceMax: city.commerceMax,
      security: city.security,
      securityMax: city.securityMax,
      defence: city.defence,
      defenceMax: city.defenceMax,
      wall: city.wall,
      wallMax: city.wallMax,
    };
  }
  if (level === 1) {
    const counts = new Map<number, number>();
    for (const g of generals) counts.set(g.crewType, (counts.get(g.crewType) ?? 0) + 1);
    record.crewTypes = [...counts]
      .sort(([a], [b]) => a - b)
      .map(([crewType, count]) => ({ crewType, generals: count }));
    if (nation) record.tech = techCompare(nation.tech, view.nations[general.nationId!]!.tech);
  }
  return record;
}
