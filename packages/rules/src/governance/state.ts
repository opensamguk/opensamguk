import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { WorldView } from '../model/world';
import { governanceConfigSchema, governanceId, governanceQuantity, readGovernanceConfig } from './config';

const nationKey = z.string().regex(/^[1-9]\d*$/);
const boundedRecord = <T extends z.ZodType>(schema: T, max: number) =>
  z.record(nationKey, schema).refine((entries) => Object.keys(entries).length <= max);
const throneSchema = z.union([
  z.strictObject({ emperorGeneralId: z.null(), emperorNationId: z.null(), sinceTick: governanceQuantity }),
  z.strictObject({ emperorGeneralId: governanceId, emperorNationId: governanceId, sinceTick: governanceQuantity }),
]);
const appointment = z.strictObject({ generalId: governanceId, appointedTick: governanceQuantity }).nullable();
export const governanceVassalSchema = z.strictObject({
  id: governanceId,
  vassalNationId: governanceId,
  overlordNationId: governanceId,
  overlordMonarchId: governanceId,
  vassalMonarchId: governanceId,
  goldBp: governanceQuantity.max(10_000),
  riceBp: governanceQuantity.max(10_000),
  sinceTick: governanceQuantity,
  remitUntilTick: governanceQuantity,
});
export const governanceOfferSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: governanceId,
    kind: z.literal('VASSAL'),
    authority: z.enum(['OWN', 'EMPIRE']),
    fromNationId: governanceId,
    sourceMonarchId: governanceId,
    actorId: governanceId,
    targetNationId: governanceId,
    direction: z.enum(['DEMAND', 'REQUEST']),
    goldBp: governanceQuantity.max(10_000),
    riceBp: governanceQuantity.max(10_000),
    expiresTick: governanceId,
  }),
  z.strictObject({
    id: governanceId,
    kind: z.literal('COURT'),
    fromNationId: governanceId,
    sourceMonarchId: governanceId,
    actorId: governanceId,
    targetGeneralId: governanceId,
    office: z.enum(['chancellor', 'grandMarshal', 'minister']),
    expiresTick: governanceId,
  }),
]);
export const governanceStateSchema = z.strictObject({
  version: z.literal(1),
  config: governanceConfigSchema,
  monthlyTick: governanceQuantity.multipleOf(TICKS_PER_MONTH),
  revision: governanceQuantity,
  nextOfferId: governanceId,
  nextVassalId: governanceId,
  throne: throneSchema,
  court: z.strictObject({ chancellor: appointment, grandMarshal: appointment, minister: appointment }),
  legitimacy: boundedRecord(governanceQuantity.max(100), 10_000),
  vassals: z.array(governanceVassalSchema).max(10_000),
  offers: z.array(governanceOfferSchema).max(200),
  pendingRenounce: z.array(governanceId).max(10_000),
  censuredAt: boundedRecord(governanceQuantity, 10_000),
  npcOfferAt: z
    .record(z.string().regex(/^[1-9]\d*:[1-9]\d*$/), governanceQuantity)
    .refine((entries) => Object.keys(entries).length <= 100_000),
});
export type GovernanceState = z.infer<typeof governanceStateSchema>;
export type GovernanceVassal = z.infer<typeof governanceVassalSchema>;
export type GovernanceOffer = z.infer<typeof governanceOfferSchema>;

// 정리 전의 군주 교체·멸망을 허용한다. 현재 월드와의 의미 검사는 reconcile의 출력에서 한다.
export function readGovernanceState(value: unknown): GovernanceState {
  const state = governanceStateSchema.parse(value);
  const vassalIds = new Set<number>(),
    offerIds = new Set<number>(),
    pending = new Set<number>();
  for (const row of state.vassals) {
    if (vassalIds.has(row.id) || row.id >= state.nextVassalId)
      throw new Error('봉신 계약 번호가 중복되거나 뒤로 돌아갔습니다.');
    vassalIds.add(row.id);
  }
  for (const row of state.offers) {
    if (offerIds.has(row.id) || row.id >= state.nextOfferId)
      throw new Error('황실 제안 번호가 중복되거나 뒤로 돌아갔습니다.');
    offerIds.add(row.id);
  }
  for (const id of state.pendingRenounce) {
    if (pending.has(id)) throw new Error('중복된 봉신 이탈 요청입니다.');
    pending.add(id);
  }
  state.vassals.sort((a, b) => a.id - b.id);
  state.offers.sort((a, b) => a.id - b.id);
  state.pendingRenounce.sort((a, b) => a - b);
  return state;
}

export function initialGovernanceState(value: unknown, world: Pick<WorldView, 'cities' | 'nations'>): GovernanceState {
  const config = readGovernanceConfig(value, world);
  return readGovernanceState({
    version: 1,
    config,
    monthlyTick: 0,
    revision: 0,
    nextOfferId: 1,
    nextVassalId: 1,
    throne: { emperorGeneralId: null, emperorNationId: null, sinceTick: 0 },
    court: { chancellor: null, grandMarshal: null, minister: null },
    legitimacy: Object.fromEntries(Object.keys(world.nations).map((id) => [id, 0])),
    vassals: [],
    offers: [],
    pendingRenounce: [],
    censuredAt: {},
    npcOfferAt: {},
  });
}
