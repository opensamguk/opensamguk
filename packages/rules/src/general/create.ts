import { z } from 'zod';
import { rngFor } from '@opensamguk/shared';
import { monthlyDate } from '../monthly/index';
import { TICKS_PER_MONTH } from '../clock/constants';
import { statRulesSchema, unitSetSchema } from '../world/resources';
import type { InitialGeneral } from '../world/bootstrap';
import type { PresetRules } from '../world/preset';

export interface CreationBonus {
  gold: number;
  rice: number;
  experience: number;
}

export function lateJoinBonus(
  config: PresetRules['boost']['lateJoin'],
  relativeYear: number,
  generals: readonly Pick<InitialGeneral, 'id' | 'nationId' | 'experience'>[],
): CreationBonus {
  const bonus = { gold: 1000, rice: 1000, experience: 0 };
  if (!config) return bonus;
  const years = Math.min(relativeYear, config.maxYears);
  bonus.gold += config.goldPerYear * years;
  bonus.rice += config.ricePerYear * years;
  if (relativeYear >= config.fromYear) {
    const members = generals
      .filter((general) => general.nationId !== null)
      .sort((a, b) => a.experience - b.experience || a.id - b.id);
    const value = members[Math.max(1, Math.round(members.length * config.percentile)) - 1];
    if (value) bonus.experience = Math.round(value.experience * config.experienceRatio);
  }
  return bonus;
}

const dbInt = z.number().int().min(0).max(2_147_483_647);
export const generalCreationSchema = z.strictObject({
  name: z
    .string()
    .transform((name) => name.normalize('NFC').trim())
    .refine(
      (name) => [...name].length >= 1 && [...name].length <= 6 && /^[가-힣\p{Script=Han}A-Za-z0-9]+$/u.test(name),
      '이름은 한글·한자·영문·숫자로 1~6글자를 입력하세요.',
    ),
  leadership: dbInt,
  strength: dbInt,
  intel: dbInt,
  portraitId: z.number().int().min(10001).max(11000).nullable(),
});
export type GeneralCreation = z.infer<typeof generalCreationSchema>;
export const CREATION_ERRORS = {
  BAD_NAME: '이름을 확인하세요.',
  BAD_STATS: '능력치 합계와 범위를 확인하세요.',
  BAD_PORTRAIT: '초상 번호를 확인하세요.',
  ALREADY_EXISTS: '이미 장수가 있습니다.',
  NAME_TAKEN: '이미 사용 중인 장수 이름입니다.',
  WORLD_CLOSED: '지금은 장수를 생성할 수 없습니다.',
  ACTOR_INACTIVE: '장수를 생성할 수 없는 계정입니다.',
} as const;
export type CreationCode = keyof typeof CREATION_ERRORS;
export function creationFailure(code: CreationCode) {
  return { code, message: CREATION_ERRORS[code] };
}
export function validateGeneralCreation(
  payload: unknown,
  statRules: unknown,
): { ok: true; value: GeneralCreation } | { ok: false; code: CreationCode; message: string } {
  const parsed = generalCreationSchema.safeParse(payload);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      ...creationFailure(path === 'name' ? 'BAD_NAME' : path === 'portraitId' ? 'BAD_PORTRAIT' : 'BAD_STATS'),
    };
  }
  const rules = statRulesSchema.parse({ stat: statRules }).stat;
  const stats = [parsed.data.leadership, parsed.data.strength, parsed.data.intel];
  if (stats.some((n) => n < rules.min || n > rules.max) || stats.reduce((a, b) => a + b, 0) !== rules.total)
    return { ok: false, ...creationFailure('BAD_STATS') };
  return { ok: true, value: parsed.data };
}
export function buildCreatedGeneral(input: {
  payload: GeneralCreation;
  seed: string;
  userId: string;
  id: number;
  startYear: number;
  monthlyTick: number;
  tick: number;
  cityKeys: number[];
  unitSet: unknown;
  bonus?: CreationBonus;
}): InitialGeneral {
  const rng = rngFor(input.seed, 'create', input.userId);
  // 고정 소비 순서: cityKey 오름차순 후보의 도시, affinity, 턴 offset.
  const cityKey = rng.pick([...input.cityKeys].sort((a, b) => a - b));
  const affinity = rng.int(1, 150);
  let nextTurnTick = input.monthlyTick + rng.int(0, TICKS_PER_MONTH - 1);
  if (nextTurnTick <= input.tick)
    nextTurnTick += (Math.floor((input.tick - nextTurnTick) / TICKS_PER_MONTH) + 1) * TICKS_PER_MONTH;
  if (nextTurnTick > 2_147_483_647 || !Number.isSafeInteger(input.id) || input.id < 1 || input.id > 2_147_483_647)
    throw new Error('장수 저장 범위를 넘었습니다.');
  // monthlyDate는 정산할 달의 끝 경계를 받는다. monthlyTick=0도 첫 달이다.
  const birthYear = monthlyDate(input.startYear, input.monthlyTick + TICKS_PER_MONTH).year - 20;
  return {
    ...input.payload,
    id: input.id,
    userId: input.userId,
    affinity,
    cityKey,
    nationId: null,
    officerLevel: 0,
    birthYear,
    deathYear: birthYear + 80,
    activeFromYear: birthYear + 15,
    personality: null,
    special: null,
    gold: input.bonus?.gold ?? 1000,
    rice: input.bonus?.rice ?? 1000,
    crew: 0,
    crewType: unitSetSchema.parse(input.unitSet).defaultCrewTypeId,
    train: 0,
    atmos: 0,
    experience: input.bonus?.experience ?? 0,
    dedication: 0,
    age: 20,
    injury: 0,
    nextTurnTick,
  };
}
