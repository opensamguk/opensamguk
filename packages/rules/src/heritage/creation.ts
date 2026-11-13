import { z } from 'zod';
import { FIVE_STAT_KEYS } from '../general/fiveStats';
import type { GeneralCreation } from '../general/create';
import { heritageBonusSchema, type HeritageBonus, type HeritageStat } from './allocation';
import { HERITAGE_V1 } from './constants';
import {
  heritageBirthSchema,
  heritageBirthCost,
  heritageBirthCosts,
  heritageBirthZone,
  type HeritageBirth,
} from './birth';
import { TICKS_PER_MONTH } from '../clock/constants';

export const HERITAGE_CREATION_MAX_COST =
  HERITAGE_V1.perGeneral + Object.values(heritageBirthCosts).reduce((sum, amount) => sum + amount, 0);
const statCost = (bonus?: HeritageBonus) =>
  Object.values(bonus ?? {}).reduce<number>((sum, amount) => sum + (amount ?? 0), 0);

const heritageStatRecordSchema = z
  .strictObject({
    version: z.literal(1),
    bonus: heritageBonusSchema,
    cost: z.number().int().min(1).max(HERITAGE_V1.perGeneral),
  })
  .refine((record) => record.cost === statCost(record.bonus));
const heritageBirthRecordSchema = z
  .strictObject({
    version: z.literal(2),
    bonus: heritageBonusSchema.optional(),
    birth: heritageBirthSchema,
    cost: z.number().int().min(1000).max(HERITAGE_CREATION_MAX_COST),
  })
  .refine((record) => record.cost === statCost(record.bonus) + heritageBirthCost(record.birth));
export const heritageCreationRecordSchema = z.union([heritageStatRecordSchema, heritageBirthRecordSchema]);
export type HeritageCreationRecord = z.infer<typeof heritageCreationRecordSchema>;

export function creationHeritageRecord(
  value: HeritageBonus | undefined,
  birth?: undefined,
): z.infer<typeof heritageStatRecordSchema> | undefined;
export function creationHeritageRecord(
  value: HeritageBonus | undefined,
  birth?: HeritageBirth,
): HeritageCreationRecord | undefined;
export function creationHeritageRecord(
  value: HeritageBonus | undefined,
  birth?: HeritageBirth,
): HeritageCreationRecord | undefined {
  const chosenBirth = birth === undefined ? undefined : heritageBirthSchema.parse(birth);
  if (value === undefined && chosenBirth === undefined) return undefined;
  const parsed = value === undefined ? {} : heritageBonusSchema.parse(value),
    bonus: HeritageBonus = {};
  for (const key of FIVE_STAT_KEYS) {
    const amount = parsed[key];
    if (amount === undefined) continue;
    bonus[key] = amount;
  }
  const cost = statCost(bonus);
  return chosenBirth
    ? { version: 2, ...(cost ? { bonus } : {}), birth: chosenBirth, cost: cost + heritageBirthCost(chosenBirth) }
    : { version: 1, bonus, cost };
}

export function createdHeritageStat(payload: GeneralCreation, key: HeritageStat): number | undefined {
  const value = payload[key];
  return value === undefined ? undefined : value + (payload.heritage?.[key] ?? 0);
}

export function assertHeritageCreationResult(payload: unknown, result: unknown, enabled: boolean, five: boolean): void {
  const body: Record<string, unknown> =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const record: Record<string, unknown> =
    result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
  if (!enabled) {
    if (Object.hasOwn(body, 'heritage') || Object.hasOwn(body, 'heritageBirth') || Object.hasOwn(record, 'heritage'))
      throw new Error('유산을 끈 판의 생성 기록에 유산 값이 있습니다.');
    return;
  }
  const expected = creationHeritageRecord(
    body.heritage as HeritageBonus | undefined,
    body.heritageBirth as HeritageBirth | undefined,
  );
  if (!expected) {
    if (Object.hasOwn(record, 'heritage')) throw new Error('배분하지 않은 유산 생성 기록입니다.');
  } else {
    if (!five && (expected.bonus?.politics !== undefined || expected.bonus?.charm !== undefined))
      throw new Error('3능력치 판에 정치·매력 유산이 있습니다.');
    const stored = heritageCreationRecordSchema.parse(record.heritage);
    if (
      stored.version !== expected.version ||
      stored.cost !== expected.cost ||
      FIVE_STAT_KEYS.some((key) => stored.bonus?.[key] !== expected.bonus?.[key]) ||
      (stored.version === 2 &&
        expected.version === 2 &&
        (Object.keys(heritageBirthCosts) as Array<keyof HeritageBirth>).some(
          (key) => stored.birth[key] !== expected.birth[key],
        ))
    )
      throw new Error('유산 생성 배분과 고정 기록이 다릅니다.');
  }
  const general = record.general;
  if (general === null || typeof general !== 'object' || Array.isArray(general))
    throw new Error('유산 생성 장수 기록이 없습니다.');
  const created = general as Record<string, unknown>;
  if (expected?.version === 2) {
    const { cityKey, turnZone, specialty } = expected.birth;
    if (
      (cityKey !== undefined && created.cityKey !== cityKey) ||
      (specialty !== undefined && created.special !== specialty)
    )
      throw new Error('유산 생성 선택과 장수 기록이 다릅니다.');
    if (turnZone !== undefined) {
      const { start, end } = heritageBirthZone(turnZone);
      const offset = typeof created.nextTurnTick === 'number' ? created.nextTurnTick % TICKS_PER_MONTH : -1;
      if (!(offset >= start && offset < end)) throw new Error('유산 생성 턴 시간대와 장수 기록이 다릅니다.');
    }
  }
  for (const key of five ? FIVE_STAT_KEYS : FIVE_STAT_KEYS.slice(0, 3)) {
    const base = body[key];
    if (
      typeof base !== 'number' ||
      !Number.isSafeInteger(base) ||
      base < 0 ||
      created[key] !== base + (expected?.bonus?.[key] ?? 0)
    )
      throw new Error('유산을 반영한 생성 능력치가 다릅니다.');
  }
}
