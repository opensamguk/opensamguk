import { z } from 'zod';
import { BALANCE } from '../../balance';
import type { WorldView } from '../../model/world';
import type { Actor, CommandDef, Failure } from '../types';
import type { CityField, Effect } from '../effects';

type Spec = {
  key: string;
  name: string;
  field: CityField | 'tech';
  stat: 'leadership' | 'strength' | 'intel';
  effectFactor?: number;
  costFactor?: number;
};
export const DOMESTIC_SPECS: readonly Spec[] = [
  { key: 'farm', name: '농지 개간', field: 'agriculture', stat: 'intel' },
  { key: 'commerce', name: '상업 투자', field: 'commerce', stat: 'intel' },
  { key: 'security', name: '치안 강화', field: 'security', stat: 'strength' },
  {
    key: 'settle',
    name: '정착 장려',
    field: 'population',
    stat: 'leadership',
    effectFactor: BALANCE.SETTLE_EFFECT_FACTOR,
    costFactor: BALANCE.SETTLE_COST_FACTOR,
  },
  {
    key: 'goodwill',
    name: '주민 선정',
    field: 'trust',
    stat: 'leadership',
    effectFactor: BALANCE.GOODWILL_EFFECT_FACTOR,
    costFactor: BALANCE.GOODWILL_COST_FACTOR,
  },
  { key: 'defence', name: '수비 강화', field: 'defence', stat: 'strength' },
  { key: 'wall', name: '성벽 보수', field: 'wall', stat: 'strength' },
  { key: 'research', name: '기술 연구', field: 'tech', stat: 'intel' },
];

function isFront(view: WorldView, cityKey: number): boolean {
  const city = view.cities[cityKey]!;
  return city.connections.some((key) => {
    const neighbor = view.cities[key];
    if (!neighbor || neighbor.nationId === null || neighbor.nationId === city.nationId) return false;
    return view.diplomacies.some(
      (d) =>
        d.state === 'WAR' &&
        ((d.nationA === city.nationId && d.nationB === neighbor.nationId) ||
          (d.nationB === city.nationId && d.nationA === neighbor.nationId)),
    );
  });
}

export function makeInvestment(spec: Spec): CommandDef {
  const cost = BALANCE.DEVEL_COST * (spec.costFactor ?? 1);
  function check(view: WorldView, actor: Actor): Failure | null {
    const general = view.generals[actor.generalId];
    if (!general) return { code: 'NO_ACTOR', message: '장수가 없습니다.' };
    const nation = general.nationId === null ? undefined : view.nations[general.nationId];
    if (!nation) return { code: 'NOT_NATION', message: '국가에 소속되어야 합니다.' };
    const city = view.cities[general.cityKey];
    if (!city || city.nationId !== general.nationId)
      return { code: 'NOT_OWN_CITY', message: '자기 국가 도시에서만 가능합니다.' };
    if (!city.supplied) return { code: 'NO_SUPPLY', message: '보급이 끊긴 도시입니다.' };
    if (general.gold < cost) return { code: 'NO_GOLD', message: '금이 부족합니다.' };
    const value = spec.field === 'tech' ? nation.tech : city[spec.field];
    const max =
      spec.field === 'tech' ? BALANCE.MAX_TECH : spec.field === 'trust' ? BALANCE.MAX_TRUST : city[`${spec.field}Max`];
    return value >= max ? { code: 'AT_MAX', message: '이미 최대치입니다.' } : null;
  }
  return {
    key: spec.key,
    name: spec.name,
    category: 'domestic',
    target: 'general',
    args: z.strictObject({}),
    precheck: check,
    check,
    execute(view, actor, _args, rng) {
      const failure = check(view, actor);
      if (failure) throw new Error(failure.message);
      const general = view.generals[actor.generalId]!;
      const city = view.cities[general.cityKey]!;
      // Replay order: base score, critical roll, then a multiplier only for a critical.
      let score = ((general[spec.stat] * city.trust) / 100) * (0.8 + rng.next() * 0.4);
      const critical = rng.next();
      if (critical < 0.1) score *= 2.2 + rng.next() * 0.8;
      else if (critical < 0.2) score *= 0.2 + rng.next() * 0.2;
      if (isFront(view, city.cityKey)) score *= BALANCE.FRONT_FACTOR;
      const points = Math.round(score);
      // 인구·민심의 단위만 바꾼다. 경험·공헌은 기존 점수로 계산한다.
      const cityScore = score * (spec.effectFactor ?? 1);
      const change = spec.field === 'trust' ? cityScore : Math.round(cityScore);
      const effect: Effect =
        spec.field === 'tech'
          ? { kind: 'nation', id: general.nationId!, field: 'tech', op: 'add', value: change }
          : { kind: 'city', id: city.cityKey, field: spec.field, op: 'add', value: change };
      return {
        effects: [
          effect,
          { kind: 'general', id: general.id, field: 'gold', op: 'add', value: -cost },
          { kind: 'general', id: general.id, field: 'experience', op: 'add', value: Math.round(score * 0.7) },
          { kind: 'general', id: general.id, field: 'dedication', op: 'add', value: points },
        ],
        logs: [{ kind: 'success', text: `${spec.name}: ${spec.field === 'trust' ? change.toFixed(1) : change}` }],
      };
    },
  };
}
