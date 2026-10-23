import { z } from 'zod';
import { TICKS_PER_MONTH } from '../clock/constants';
import type { DeepReadonly, WorldState } from '../model/world';
import { canExecuteNationCommand } from '../personnel/permissions';
import type {
  FirstTreatyClause,
  TreatyApplyResult,
  TreatyClause,
  TreatyClosure,
  TreatyInput,
  TreatyRecord,
  TreatyRecordContext,
  TreatyRejectCode,
  TreatyState,
} from './treatyTypes';

export type TreatyAmounts = Readonly<{ from: number; to: number }>;

export type TreatyFeeResult = { ok: true; gold: TreatyAmounts } | { ok: false; gold: TreatyAmounts };

export type TreatyRelation = 'NONE' | 'WAR' | 'DECLARED' | 'NON_AGGRESSION';

function nonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

// 첫 세 조항용이다. 이 함수는 중복 조항과 뒤 조항의 기간 합산을 정하지 않는다.
export function calculateTreatyFee(cityCount: number, nonAggressionMonths: number | null): number {
  nonNegativeSafeInteger(cityCount, 'cityCount');
  if (nonAggressionMonths === null) return 0;
  if (!Number.isInteger(nonAggressionMonths) || nonAggressionMonths < 1 || nonAggressionMonths > 120)
    throw new RangeError('nonAggressionMonths must be an integer between 1 and 120');

  const fee = (BigInt(cityCount) * 100n * BigInt(nonAggressionMonths) + 11n) / 12n;
  if (fee > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('treaty fee exceeds the safe integer range');
  return Number(fee);
}

// 엔진이 같은 트랜잭션 안에서 읽은 국고와 비용으로 부른다. 이 함수는 상태를 저장하지 않는다.
export function settleTreatyFees(gold: TreatyAmounts, cost: TreatyAmounts): TreatyFeeResult {
  nonNegativeSafeInteger(gold.from, 'gold.from');
  nonNegativeSafeInteger(gold.to, 'gold.to');
  nonNegativeSafeInteger(cost.from, 'cost.from');
  nonNegativeSafeInteger(cost.to, 'cost.to');
  if (gold.from < cost.from || gold.to < cost.to) return { ok: false, gold: { ...gold } };
  return { ok: true, gold: { from: gold.from - cost.from, to: gold.to - cost.to } };
}

// Q7 조건만 판정한다. 종전 자체나 다른 관계 조합의 유효성을 뜻하지 않는다.
export function meetsTreatyPeaceRequirement(
  relation: TreatyRelation,
  clauses: Readonly<{ peace: boolean; nonAggression: boolean }>,
): boolean {
  return !clauses.nonAggression || clauses.peace || (relation !== 'WAR' && relation !== 'DECLARED');
}

// 공통 검증을 마친 제안에만 쓴다. 모양·기간·관계 검사 실패는 valid=false로 넘긴다.
// 조항 종류는 빈 배열이 아닌 검증 결과다. 빈 조약과 중복 조항 정책은 이 helper가 정하지 않는다.
export function canNpcAcceptTreaty(proposal: {
  valid: boolean;
  clauseKinds: readonly [string, ...string[]];
  gold: number;
  cost: number;
}): boolean {
  nonNegativeSafeInteger(proposal.gold, 'gold');
  nonNegativeSafeInteger(proposal.cost, 'cost');
  return (
    proposal.valid &&
    proposal.clauseKinds.every((kind) => kind === 'peace' || kind === 'nonAggression' || kind === 'note') &&
    proposal.gold >= proposal.cost
  );
}
export type TreatyWorldState = WorldState & { treaties?: TreatyState[] };
type TreatyView = DeepReadonly<TreatyWorldState>;

// PostgreSQL Int와 actionSequence의 저장 범위다.
const MAX_STORED_INT = 2_147_483_647;
const RESPONSE_MONTHS = 6;
const clauseKinds = ['peace', 'nonAggression', 'passage', 'tribute', 'trade', 'cityTransfer', 'note'] as const;
const integer = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
const tickSchema = integer.min(0);
const treatyIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const clauseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('peace') }),
  z.strictObject({ kind: z.literal('nonAggression'), months: integer }),
  z.strictObject({ kind: z.literal('passage'), cityKeys: z.array(integer) }),
  z.strictObject({ kind: z.literal('tribute'), payerNationId: integer, gold: integer, rice: integer, months: integer }),
  z.strictObject({ kind: z.literal('trade'), months: integer }),
  z.strictObject({ kind: z.literal('cityTransfer'), cityKey: integer, giverNationId: integer }),
  z.strictObject({ kind: z.literal('note'), text: z.string() }),
]);
const proposeRaw = z.strictObject({ toNationId: positive, clauses: z.array(clauseSchema) });
const proposeStored = proposeRaw.refine(
  ({ clauses }) => clauses.every((clause, i) => i === 0 || clauseOrder(clauses[i - 1]!) <= clauseOrder(clause)),
  '조항 저장 순서를 확인하세요.',
);
const respondPayload = z.strictObject({ treatyId: treatyIdSchema, accept: z.boolean() });

function clauseOrder(clause: TreatyClause): number {
  return clauseKinds.indexOf(clause.kind);
}

const proposeRejectCodes = [
  'WORLD_CLOSED',
  'ACTOR_INACTIVE',
  'NO_GENERAL',
  'BAD_INPUT',
  'CLAUSE_NOT_CONNECTED',
  'NO_PERMISSION',
  'BAD_TARGET',
  'TREATY_RELATION',
  'INSUFFICIENT_GOLD',
] as const;
const respondRejectCodes = [
  'WORLD_CLOSED',
  'ACTOR_INACTIVE',
  'NO_GENERAL',
  'NO_PERMISSION',
  'BAD_TARGET',
  'NOT_PARTY',
  'TREATY_NOT_PROPOSED',
  'EXPIRED',
  'TREATY_RELATION',
  'INSUFFICIENT_GOLD',
  'COUNTERPART_UNAVAILABLE',
] as const;

// raw 요청의 정규화와 저장된 payload의 검사를 구분한다. 중앙 kind 목록에는 여기서 등록하지 않는다.
export const TREATY_INPUTS = Object.freeze({
  'treaty.propose': Object.freeze({
    payloadSchema: proposeStored,
    rejectedCodes: proposeRejectCodes,
    normalizePayload(value: unknown) {
      const parsed = proposeRaw.parse(value);
      parsed.clauses = parsed.clauses
        .map((clause) => (clause.kind === 'note' ? { ...clause, text: clause.text.normalize('NFC') } : clause))
        .sort((a, b) => clauseOrder(a) - clauseOrder(b));
      return proposeStored.parse(parsed);
    },
  }),
  'treaty.respond': Object.freeze({
    payloadSchema: respondPayload,
    rejectedCodes: respondRejectCodes,
    normalizePayload: (value: unknown) => respondPayload.parse(value),
  }),
});

const costsSchema = z.strictObject({ from: tickSchema, to: tickSchema });
const proposedResult = z.strictObject({
  outcome: z.literal('PROPOSED'),
  tick: tickSchema,
  treatyId: treatyIdSchema,
  respondByTick: tickSchema,
});
const acceptedResult = z.strictObject({
  outcome: z.literal('ACCEPTED'),
  by: z.enum(['HUMAN', 'NPC']),
  tick: tickSchema,
  treatyId: treatyIdSchema,
  cost: costsSchema,
  endTick: tickSchema.nullable(),
});
const declinedResult = z.strictObject({
  outcome: z.literal('DECLINED'),
  by: z.enum(['HUMAN', 'NPC']),
  tick: tickSchema,
  treatyId: treatyIdSchema,
});
const appliedResult = z.discriminatedUnion('outcome', [proposedResult, acceptedResult, declinedResult]);
const envelope = z.strictObject({
  sequence: positive.max(MAX_STORED_INT),
  generalId: positive,
  kind: z.enum(['treaty.propose', 'treaty.respond']),
  status: z.enum(['APPLIED', 'REJECTED']),
  payload: z.unknown(),
  result: z.unknown(),
});

function checkedTickAdd(tick: number, months: number): number {
  const result = tick + months * TICKS_PER_MONTH;
  if (!Number.isSafeInteger(result) || result > MAX_STORED_INT)
    throw new RangeError('조약 기한 저장 범위를 넘었습니다.');
  return result;
}

// 전체 archive 외피·sequence 순서는 호출자가 검사한다. APPLIED의 게임 결과는 재실행 뒤 대조해야 한다.
export function validateTreatyRecord(value: unknown, context: TreatyRecordContext): TreatyRecord {
  if (context.treaty?.version !== 1) throw new Error('조약 기능이 켜진 기록이 아닙니다.');
  nonNegativeSafeInteger(context.monthlyTick, 'monthlyTick');
  const record = envelope.parse(value);
  const payload = TREATY_INPUTS[record.kind].payloadSchema.parse(record.payload);
  const result =
    record.status === 'APPLIED'
      ? appliedResult.parse(record.result)
      : z
          .strictObject({
            tick: tickSchema,
            code: z.enum(TREATY_INPUTS[record.kind].rejectedCodes),
            message: z.string().min(1),
          })
          .parse(record.result);
  if (result.tick > MAX_STORED_INT) throw new RangeError('기록 tick 저장 범위를 넘었습니다.');
  if (context.endTick !== undefined) {
    nonNegativeSafeInteger(context.endTick, 'endTick');
    if (
      record.status !== 'REJECTED' ||
      !('code' in result) ||
      result.code !== 'WORLD_CLOSED' ||
      result.tick < context.endTick
    )
      throw new Error('종료 뒤 조약 기록을 확인하세요.');
  } else if (result.tick < context.monthlyTick) throw new Error('이미 정산한 시각보다 앞선 조약 기록입니다.');
  if (record.status === 'APPLIED' && 'outcome' in result) {
    const expectedId =
      record.kind === 'treaty.propose' ? String(record.sequence) : respondPayload.parse(payload).treatyId;
    if (result.treatyId !== expectedId) throw new Error('조약 기록의 ID가 다릅니다.');
    if (record.kind === 'treaty.propose') {
      const proposal = proposeStored.parse(payload);
      if (domainClauses(proposal.clauses)) throw new Error('적용한 제안의 조항을 확인하세요.');
      if (result.outcome === 'PROPOSED') {
        if (result.respondByTick !== checkedTickAdd(result.tick, RESPONSE_MONTHS))
          throw new Error('조약 응답 기한이 다릅니다.');
      } else if (result.by !== 'NPC') throw new Error('제안 기록의 응답 주체가 다릅니다.');
      if (result.outcome === 'ACCEPTED') {
        const months = proposal.clauses.find((c) => c.kind === 'nonAggression')?.months;
        const expectedEnd = months === undefined ? null : checkedTickAdd(result.tick, months);
        if (result.endTick !== expectedEnd) throw new Error('조약 종료 시각이 다릅니다.');
      }
    } else {
      const response = respondPayload.parse(payload);
      if (result.outcome === 'PROPOSED' || result.by !== 'HUMAN' || response.accept !== (result.outcome === 'ACCEPTED'))
        throw new Error('응답 기록의 결과가 다릅니다.');
    }
  }
  return { ...record, payload, result } as TreatyRecord;
}

const rejectionMessages: Record<TreatyRejectCode, string> = {
  WORLD_CLOSED: '실행 중인 월드가 아닙니다.',
  ACTOR_INACTIVE: '행동할 수 없는 계정입니다.',
  NO_GENERAL: '행위 장수가 없습니다.',
  BAD_INPUT: '조약 조항을 확인하세요.',
  CLAUSE_NOT_CONNECTED: '아직 연결하지 않은 조항입니다.',
  NO_PERMISSION: '조약을 처리할 권한이 없습니다.',
  BAD_TARGET: '조약 상대 국가를 확인하세요.',
  NOT_PARTY: '받은 조약에만 응답할 수 있습니다.',
  TREATY_NOT_PROPOSED: '응답을 기다리는 조약이 아닙니다.',
  EXPIRED: '조약 응답 기한이 지났습니다.',
  TREATY_RELATION: '현재 외교 관계에서 맺을 수 없는 조항입니다.',
  INSUFFICIENT_GOLD: '국고의 금이 부족합니다.',
  COUNTERPART_UNAVAILABLE: '상대 국가의 사정으로 수락하지 못했습니다.',
};

function domainClauses(clauses: readonly TreatyClause[]): TreatyRejectCode | null {
  if (
    clauses.length === 0 ||
    new Set(clauses.map((c) => c.kind)).size !== clauses.length ||
    clauses.some((c) => c.kind === 'nonAggression' && (c.months < 1 || c.months > 120)) ||
    clauses.some(
      (c) =>
        c.kind === 'note' && ([...c.text.normalize('NFC')].length < 1 || [...c.text.normalize('NFC')].length > 300),
    )
  )
    return 'BAD_INPUT';
  return clauses.some((c) => !isFirstClause(c)) ? 'CLAUSE_NOT_CONNECTED' : null;
}

function isFirstClause(clause: TreatyClause): clause is FirstTreatyClause {
  return clause.kind === 'peace' || clause.kind === 'nonAggression' || clause.kind === 'note';
}

function relationAllows(state: TreatyView, from: number, to: number, clauses: readonly FirstTreatyClause[]): boolean {
  const relation = state.diplomacies.find((d) => d.nationA === Math.min(from, to) && d.nationB === Math.max(from, to));
  const peace = clauses.some((c) => c.kind === 'peace');
  const nonAggression = clauses.some((c) => c.kind === 'nonAggression');
  const current = relation?.state ?? 'NONE';
  return (
    (!peace || current === 'WAR' || current === 'DECLARED') &&
    !(nonAggression && current === 'NON_AGGRESSION') &&
    meetsTreatyPeaceRequirement(current, { peace, nonAggression })
  );
}

function putTreaties(state: TreatyWorldState, treaties: TreatyState[]): void {
  if (treaties.length) state.treaties = treaties.sort((a, b) => a.id - b.id);
  else delete state.treaties;
}

export function applyTreatyInput(
  state: TreatyView,
  input: TreatyInput & { generalId: number },
  context: { tick: number; sequence: number },
): TreatyApplyResult<TreatyWorldState> {
  const { tick, sequence } = context;
  tickSchema.max(MAX_STORED_INT).parse(tick);
  positive.max(MAX_STORED_INT).parse(sequence);
  positive.parse(input.generalId);
  const payload = TREATY_INPUTS[input.kind].payloadSchema.parse(input.payload);
  const reject = (code: TreatyRejectCode): TreatyApplyResult<TreatyWorldState> => ({
    ok: false,
    result: { tick, code, message: rejectionMessages[code] },
  });
  if (input.kind === 'treaty.propose') {
    const domain = domainClauses(proposeStored.parse(payload).clauses);
    if (domain) return reject(domain);
  }
  const actor = state.generals[input.generalId];
  if (!actor) return reject('NO_GENERAL');
  if (actor.nationId === null || !canExecuteNationCommand(actor.officerLevel, 'nation_pact'))
    return reject('NO_PERMISSION');
  const fromActor = state.nations[actor.nationId];
  if (!fromActor) return reject('BAD_TARGET');
  let treaty: TreatyState;
  let response: boolean | null = null;
  if (input.kind === 'treaty.propose') {
    const proposal = proposeStored.parse(payload);
    if (proposal.toNationId === actor.nationId || !state.nations[proposal.toNationId]) return reject('BAD_TARGET');
    if (state.treaties?.some((entry) => entry.id === sequence)) throw new Error('이미 사용한 조약 순서입니다.');
    treaty = {
      id: sequence,
      fromNationId: actor.nationId,
      toNationId: proposal.toNationId,
      clauses: structuredClone(proposal.clauses.filter(isFirstClause)),
      status: 'PROPOSED',
      proposedTick: tick,
      respondByTick: checkedTickAdd(tick, RESPONSE_MONTHS),
      startTick: null,
      endTick: null,
    };
  } else {
    const respond = respondPayload.parse(payload);
    const found = state.treaties?.find((entry) => String(entry.id) === respond.treatyId);
    if (!found) return reject('TREATY_NOT_PROPOSED');
    if (!state.nations[found.fromNationId] || !state.nations[found.toNationId]) return reject('BAD_TARGET');
    if (actor.nationId !== found.toNationId) return reject('NOT_PARTY');
    if (found.status !== 'PROPOSED') return reject('TREATY_NOT_PROPOSED');
    if (tick >= found.respondByTick) return reject('EXPIRED');
    treaty = structuredClone(found) as TreatyState;
    response = respond.accept;
  }
  const npc = input.kind === 'treaty.propose' && state.nations[treaty.toNationId]!.isNpc;
  const by = npc ? 'NPC' : 'HUMAN';
  const resultId = String(treaty.id);
  if (response === false) {
    const next = structuredClone(state) as TreatyWorldState;
    putTreaties(
      next,
      (next.treaties ?? []).filter((entry) => entry.id !== treaty.id),
    );
    return { ok: true, state: next, result: { outcome: 'DECLINED', by, tick, treatyId: resultId } };
  }
  if (!relationAllows(state, treaty.fromNationId, treaty.toNationId, treaty.clauses)) return reject('TREATY_RELATION');
  if (input.kind === 'treaty.propose' && !npc) {
    const next = structuredClone(state) as TreatyWorldState;
    putTreaties(next, [...(next.treaties ?? []), treaty]);
    return {
      ok: true,
      state: next,
      result: { outcome: 'PROPOSED', tick, treatyId: resultId, respondByTick: treaty.respondByTick },
    };
  }
  const months = treaty.clauses.find((c) => c.kind === 'nonAggression')?.months ?? null;
  const cities = Object.values(state.cities);
  const cost = {
    from: calculateTreatyFee(cities.filter((c) => c.nationId === treaty.fromNationId).length, months),
    to: calculateTreatyFee(cities.filter((c) => c.nationId === treaty.toNationId).length, months),
  };
  const gold = { from: state.nations[treaty.fromNationId]!.gold, to: state.nations[treaty.toNationId]!.gold };
  if (npc) {
    if (gold.from < cost.from) return reject('INSUFFICIENT_GOLD');
    if (
      !canNpcAcceptTreaty({
        valid: true,
        clauseKinds: treaty.clauses.map((c) => c.kind) as [string, ...string[]],
        gold: gold.to,
        cost: cost.to,
      })
    ) {
      return {
        ok: true,
        state: structuredClone(state) as TreatyWorldState,
        result: { outcome: 'DECLINED', by, tick, treatyId: resultId },
      };
    }
  } else {
    if (gold.to < cost.to) return reject('INSUFFICIENT_GOLD');
    if (gold.from < cost.from) return reject('COUNTERPART_UNAVAILABLE');
  }
  const fees = settleTreatyFees(gold, cost);
  if (!fees.ok) throw new Error('조약 비용 검사 결과가 일치하지 않습니다.');
  const next = structuredClone(state) as TreatyWorldState;
  next.nations[treaty.fromNationId]!.gold = fees.gold.from;
  next.nations[treaty.toNationId]!.gold = fees.gold.to;
  treaty.status = 'ACTIVE';
  treaty.startTick = tick;
  treaty.endTick = months === null ? null : checkedTickAdd(tick, months);
  if (treaty.clauses.some((c) => c.kind === 'peace' || c.kind === 'nonAggression')) {
    next.diplomacies = next.diplomacies.filter(
      (d) =>
        !(
          d.nationA === Math.min(treaty.fromNationId, treaty.toNationId) &&
          d.nationB === Math.max(treaty.fromNationId, treaty.toNationId)
        ),
    );
    if (treaty.endTick !== null)
      next.diplomacies.push({
        nationA: Math.min(treaty.fromNationId, treaty.toNationId),
        nationB: Math.max(treaty.fromNationId, treaty.toNationId),
        state: 'NON_AGGRESSION',
        untilTick: treaty.endTick,
      });
    next.diplomacies.sort((a, b) => a.nationA - b.nationA || a.nationB - b.nationB);
  }
  putTreaties(next, [...(next.treaties ?? []).filter((entry) => entry.id !== treaty.id), treaty]);
  return {
    ok: true,
    state: next,
    result: { outcome: 'ACCEPTED', by, tick, treatyId: resultId, cost, endTick: treaty.endTick },
  };
}

// 기존 diplomacy 단계가 관계를 정산한 뒤 같은 월 경계에서 부른다.
export function settleTreaties(state: TreatyView, tick: number): TreatyWorldState {
  if (!Number.isSafeInteger(tick) || tick <= 0 || tick % TICKS_PER_MONTH !== 0)
    throw new RangeError('월 경계 tick이 필요합니다.');
  const next = structuredClone(state) as TreatyWorldState;
  putTreaties(
    next,
    (next.treaties ?? []).filter(
      (entry) =>
        next.nations[entry.fromNationId] &&
        next.nations[entry.toNationId] &&
        (entry.status === 'PROPOSED' ? entry.respondByTick > tick : entry.endTick === null || entry.endTick > tick),
    ),
  );
  return next;
}

export function treatyClosures(before: TreatyView, next: TreatyView): TreatyClosure[] {
  const remaining = new Set(next.treaties?.map((entry) => entry.id) ?? []);
  return (before.treaties ?? [])
    .filter((entry) => !remaining.has(entry.id))
    .map((entry): TreatyClosure => ({ id: entry.id, status: entry.status === 'PROPOSED' ? 'EXPIRED' : 'ENDED' }))
    .sort((a, b) => a.id - b.id);
}
