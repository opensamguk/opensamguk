import type { WorldView } from '../model/world';

export const COMBAT_SPECIALTY_FEATURE = 'combat-specialty-v1';

type Specialty = {
  description: string;
  armType?: number;
  dealt?: readonly [attacking: number, defending: number];
  taken?: readonly [attacking: number, defending: number];
  wallDamage?: number;
  regional?: boolean;
  avoid?: number;
};

const specialties: Readonly<Record<string, Specialty>> = {
  보병: {
    description: '보병 징·모병비 10% 감소, 공격 시 받는 피해 10% 감소, 수비 시 20% 감소',
    armType: 1,
    taken: [0.9, 0.8],
  },
  궁병: { description: '궁병 징·모병비 10% 감소, 회피 확률 20%p 증가', armType: 2, avoid: 0.2 },
  기병: {
    description: '기병 징·모병비 10% 감소, 공격 피해 20% 증가, 수비 중 가하는 피해 10% 증가',
    armType: 3,
    dealt: [1.2, 1.1],
  },
  귀병: { description: '귀병 징·모병비 10% 감소, 귀병 숙련 가산', armType: 4 },
  공성: { description: '차병 징·모병비 10% 감소, 성벽에 가하는 피해 100% 증가', armType: 5, wallDamage: 2 },
  견고: { description: '받는 피해 10% 감소', taken: [0.9, 0.9] },
  돌격: { description: '공격 피해 5% 증가', dealt: [1.05, 1] },
  필살: { description: '필살 확률 30%p 증가, 필살 피해 증가와 대상 회피 차단' },
  무쌍: { description: '필살 확률 10%p 증가' },
  신산: { description: '전투계략 시도와 성공 확률 20%p 증가' },
  환술: { description: '전투계략 성공 확률 10%p 증가, 성공 피해 30% 증가' },
  반계: { description: '상대 전투계략 성공 확률 10%p 감소' },
  척사: {
    description: '지역 제한 병종 상대 피해 20% 증가, 받는 피해 20% 감소',
    dealt: [1.2, 1.2],
    taken: [0.8, 0.8],
    regional: true,
  },
};

export const combatSpecialtyNames = Object.keys(specialties);
export function combatSpecialtyKey(general: { special: string | null; combatSpecial?: string | null }) {
  return general.combatSpecial === undefined ? general.special : general.combatSpecial;
}

export function combatSpecialty(view: Pick<WorldView, 'ruleFeatures'>, key: string | null | undefined) {
  const name = key?.replace(/^che_/, '');
  if (!view.ruleFeatures?.includes(COMBAT_SPECIALTY_FEATURE) || !name || !Object.hasOwn(specialties, name))
    return undefined;
  return { name, ...specialties[name]! };
}
export type CombatSpecialty = NonNullable<ReturnType<typeof combatSpecialty>>;
