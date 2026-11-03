import { z } from 'zod';
import { generalSexSchema } from '../general/sex';
import { TICKS_PER_MONTH } from '../clock/constants';
import { LINEAGE_EXITED_YEAR, lineageConfigSchema, lineageId, lineageQuantity } from './config';
import type { WorldView } from '../model/world';

const nullableId = lineageId.nullable();
const person = z.strictObject({
  parents: z.union([z.tuple([]), z.tuple([lineageId, lineageId])]),
  bornTick: lineageQuantity.nullable(),
  exit: z
    .strictObject({
      tick: lineageQuantity,
      cause: z.enum(['DIED', 'SUCCEEDED']),
      activeFromYear: z
        .number()
        .int()
        .min(-2_147_483_648)
        .max(LINEAGE_EXITED_YEAR - 1),
    })
    .nullable(),
  successorId: nullableId,
  heirId: nullableId,
});
export const lineageStateSchema = z.strictObject({
  version: z.literal(1),
  config: lineageConfigSchema,
  seed: z.string().min(1).max(1000),
  monthlyTick: lineageQuantity.multipleOf(TICKS_PER_MONTH),
  revision: lineageQuantity,
  nextOfferId: lineageId,
  nextMarriageId: lineageId,
  persons: z.record(z.string().regex(/^[1-9]\d*$/), person),
  marriages: z.array(
    z.strictObject({
      id: lineageId,
      a: lineageId,
      b: lineageId,
      householdGeneralId: lineageId,
      sinceTick: lineageQuantity,
    }),
  ),
  offers: z.array(
    z.strictObject({
      id: lineageId,
      fromId: lineageId,
      toId: lineageId,
      expiresTick: lineageId,
    }),
  ),
});
export type LineageState = z.infer<typeof lineageStateSchema>;
export type LineagePerson = LineageState['persons'][string];
export type LineageMarriage = LineageState['marriages'][number];
export type LineageOffer = LineageState['offers'][number];
export const emptyLineagePerson = (): LineagePerson => ({
  parents: [],
  bornTick: null,
  exit: null,
  successorId: null,
  heirId: null,
});

// 참조·생존 조건은 정리 후 검사한다. 로드 때는 다른 기능이 바꾼 소속을 허용한다.
export function readLineageState(value: unknown): LineageState {
  const state = lineageStateSchema.parse(value),
    { config } = state;
  if (
    Object.keys(state.persons).length > config.limits.maxGenerals ||
    state.marriages.length > Math.floor((config.limits.maxGenerals * config.marriage.maxSpouses) / 2) ||
    state.offers.length > config.limits.worldOffers
  )
    throw new Error('가문 저장 상한을 넘었습니다.');
  const ids = new Set<number>(),
    pairs = new Set<string>(),
    spouses = new Map<number, number>();
  for (const marriage of state.marriages) {
    const pair = `${marriage.a}:${marriage.b}`;
    if (
      ids.has(marriage.id) ||
      marriage.id >= state.nextMarriageId ||
      marriage.a >= marriage.b ||
      pairs.has(pair) ||
      ![marriage.a, marriage.b].includes(marriage.householdGeneralId)
    )
      throw new Error('혼인 번호·당사자·가문을 확인하세요.');
    ids.add(marriage.id);
    pairs.add(pair);
    for (const id of [marriage.a, marriage.b]) {
      spouses.set(id, (spouses.get(id) ?? 0) + 1);
      if (spouses.get(id)! > config.marriage.maxSpouses) throw new Error('배우자 수 상한을 넘었습니다.');
    }
  }
  ids.clear();
  pairs.clear();
  for (const offer of state.offers) {
    const pair = `${Math.min(offer.fromId, offer.toId)}:${Math.max(offer.fromId, offer.toId)}`;
    if (pairs.has(pair)) throw new Error('같은 혼인 쌍의 미결 제안은 하나여야 합니다.');
    pairs.add(pair);
    if (ids.has(offer.id) || offer.id >= state.nextOfferId || offer.fromId === offer.toId)
      throw new Error('혼인 제안 번호·당사자를 확인하세요.');
    ids.add(offer.id);
  }
  for (const [key, entry] of Object.entries(state.persons)) {
    if (
      Number(key) > LINEAGE_EXITED_YEAR ||
      entry.parents.some((id) => id === Number(key)) ||
      (entry.parents.length === 2 && entry.parents[0] === entry.parents[1]) ||
      entry.heirId === Number(key) ||
      entry.successorId === Number(key) ||
      (entry.exit === null && entry.successorId !== null)
    )
      throw new Error('혈연·후계자 참조를 확인하세요.');
  }
  state.marriages.sort((a, b) => a.id - b.id);
  state.offers.sort((a, b) => a.id - b.id);
  return state;
}

export function initialLineageState(value: unknown, world: WorldView, seed: string): LineageState {
  const config = lineageConfigSchema.parse(value);
  for (const general of Object.values(world.generals)) generalSexSchema.parse(general.sex);
  if (
    Object.keys(world.generals).length > config.limits.maxGenerals ||
    Object.values(world.generals).some((general) => general.activeFromYear >= LINEAGE_EXITED_YEAR)
  )
    throw new Error('가문 원생성 인원과 퇴장 표지를 확인하세요.');
  return readLineageState({
    version: 1,
    config,
    seed,
    monthlyTick: 0,
    revision: 0,
    nextOfferId: 1,
    nextMarriageId: 1,
    persons: {},
    marriages: [],
    offers: [],
  });
}
