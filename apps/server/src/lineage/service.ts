import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  checkReplayOrigin,
  decideLineageAction,
  lineageView,
  lineageResultSchema,
  lineageRejectionSchema,
  validateLineageRecord,
  TICKS_PER_MONTH,
} from '@opensamguk/rules';
import type { LineageIdentity, LineageRequest, LineageSnapshot, LineageStore } from './ports';
import { visibility } from '../visibility';
import { lineageGetInput, lineageRequestInput, lineageSubmitInput } from './schemas';

type FailureCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED';
export class LineageServiceError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: FailureCode, message: string): never {
  throw new LineageServiceError(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('BAD_REQUEST', '가문 요청 인자가 잘못되었습니다.');
  return result.data;
}
function ready(snapshot: LineageSnapshot) {
  if (!snapshot.authenticated) fail('UNAUTHORIZED', '로그인이 필요합니다.');
  const world = snapshot.world;
  if (!world) fail('NOT_FOUND', '월드가 없습니다.');
  if (world.replayFormat !== 3 || !world.ruleFeatures.includes('lineage-v1'))
    fail('PRECONDITION_FAILED', '가문 기능을 켠 새 월드가 아닙니다.');
  const origin = world.replayOrigin;
  checkReplayOrigin(origin);
  if (
    origin.version !== 3 ||
    !isDeepStrictEqual(world.ruleFeatures, origin.initial.ruleFeatures) ||
    !isDeepStrictEqual(world.unitSet, origin.initial.unitSet)
  )
    throw Error('가문의 기능·병종이 원생성과 다릅니다.');
  return world;
}
function viewer(snapshot: LineageSnapshot, userId: string) {
  return snapshot.state ? (Object.values(snapshot.state.generals).find((g) => g.userId === userId)?.id ?? null) : null;
}
function requestDto(requestId: string, event: LineageRequest) {
  if (event.kind !== 'lineage.act' || event.idempotencyKey !== `lineage:${requestId}`)
    throw Error('가문 요청 종류·번호가 다릅니다.');
  if (event.status === 'PENDING') {
    if (event.sequence !== null || event.tick !== null || event.result !== null)
      throw Error('대기 가문 요청에 결과가 있습니다.');
    return { requestId, status: 'pending' as const };
  }
  validateLineageRecord({
    kind: event.kind,
    generalId: event.generalId,
    sequence: event.sequence!,
    tick: event.tick,
    status: event.status,
    payload: event.payload,
    result: event.result,
  });
  return event.status === 'APPLIED'
    ? { requestId, status: 'applied' as const, result: lineageResultSchema.parse(event.result) }
    : { requestId, status: 'rejected' as const, result: safeRejection(event.result) };
}
function safeRejection(value: unknown) {
  const result = lineageRejectionSchema.parse(value);
  return result.reason === 'HEIR_RESERVED'
    ? { code: result.code, message: '지금은 후계자로 지정할 수 없습니다.' }
    : result;
}
export async function readLineageBoard(store: LineageStore, identity: LineageIdentity, value: unknown) {
  const input = parse(lineageGetInput, value),
    snapshot = await store.read(identity, input.worldId),
    world = ready(snapshot);
  if (!snapshot.state?.lineage) throw Error('가문 조회 상태가 없습니다.');
  if (input.generalId !== undefined && !snapshot.state.generals[input.generalId]) fail('NOT_FOUND', '장수가 없습니다.');
  const actorId = viewer(snapshot, identity.userId),
    actor = actorId === null ? null : (snapshot.state.generals[actorId] ?? null);
  const view = lineageView(snapshot.state, actorId, world.clockTick, input.generalId, visibility(actor).general),
    settling = world.clockTick >= world.monthlyTick + TICKS_PER_MONTH;
  return {
    userId: identity.userId,
    worldId: input.worldId,
    status: world.status,
    tick: world.clockTick,
    settling,
    canSubmit: view.mine?.active === true && world.status === 'RUNNING' && !snapshot.sanctioned && !settling,
    view,
  };
}
export async function readLineageRequest(store: LineageStore, identity: LineageIdentity, value: unknown) {
  const input = parse(lineageRequestInput, value),
    snapshot = await store.request(identity, input.worldId, input.requestId);
  ready(snapshot);
  if (!snapshot.previous) fail('NOT_FOUND', '가문 요청이 없습니다.');
  return { userId: identity.userId, ...requestDto(input.requestId, snapshot.previous) };
}
export async function submitLineageRequest(store: LineageStore, identity: LineageIdentity, value: unknown) {
  const input = parse(lineageSubmitInput, value);
  if (input.expectedUserId !== identity.userId) fail('CONFLICT', '로그인 계정이 바뀌었습니다. 화면을 다시 불러오세요.');
  const event = await store.submit(identity, input.worldId, input.requestId, (snapshot) => {
    const world = ready(snapshot);
    if (snapshot.sanctioned) fail('FORBIDDEN', '이 월드의 이용이 제한됐습니다.');
    if (snapshot.previous) {
      if (
        snapshot.previous.kind !== 'lineage.act' ||
        snapshot.previous.generalId !== input.expectedGeneralId ||
        !isDeepStrictEqual(snapshot.previous.payload, input.payload)
      )
        fail('CONFLICT', '같은 요청 번호로 다른 내용을 보냈습니다.');
      return { enqueue: false };
    }
    if (world.status !== 'RUNNING') fail('PRECONDITION_FAILED', '실행 중인 월드가 아닙니다.');
    if (world.clockTick >= world.monthlyTick + TICKS_PER_MONTH)
      fail('CONFLICT', '월 정산이 진행 중입니다. 완료 뒤 다시 보내세요.');
    const actorId = viewer(snapshot, identity.userId);
    if (actorId === null) fail('NOT_FOUND', '장수가 없습니다.');
    if (actorId !== input.expectedGeneralId) fail('CONFLICT', '조작 장수가 바뀌었습니다. 화면을 다시 불러오세요.');
    if (input.payload.type === 'marriage.respond') {
      const offerId = input.payload.offerId;
      if (!snapshot.state!.lineage!.offers.some((row) => row.id === offerId && row.toId === actorId))
        fail('FORBIDDEN', '받은 혼인 제안에만 응답할 수 있습니다.');
    }
    const outcome = decideLineageAction(snapshot.state!, actorId, input.payload, world.clockTick);
    if (!outcome.ok)
      fail(
        ['NOT_OWNER', 'NOT_PARTY'].includes(outcome.code) ? 'FORBIDDEN' : 'BAD_REQUEST',
        outcome.reason === 'HEIR_RESERVED' ? '지금은 후계자로 지정할 수 없습니다.' : outcome.message,
      );
    return { enqueue: true, generalId: actorId, payload: input.payload };
  });
  return { userId: identity.userId, ...requestDto(input.requestId, event) };
}
