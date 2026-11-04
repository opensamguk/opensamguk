import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  checkReplayOrigin,
  decideStratagemCardsAction,
  stratagemCardsView,
  stratagemCardsResultSchema,
  validateStratagemCardsRecord,
  TICKS_PER_MONTH,
} from '@opensamguk/rules';
import type {
  StratagemCardsIdentity,
  StratagemCardsRequest,
  StratagemCardsSnapshot,
  StratagemCardsStore,
} from './ports';
import { stratagemCardsWorldInput, stratagemCardsRequestInput, stratagemCardsSubmitInput } from './schemas';

type FailureCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED';
export class StratagemCardsServiceError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: FailureCode, message: string): never {
  throw new StratagemCardsServiceError(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('BAD_REQUEST', '계략 패 요청 인자가 잘못되었습니다.');
  return result.data;
}
function worldOf(snapshot: StratagemCardsSnapshot) {
  if (!snapshot.authenticated) fail('UNAUTHORIZED', '로그인이 필요합니다.');
  if (!snapshot.world) fail('NOT_FOUND', '월드가 없습니다.');
  return snapshot.world;
}
function ready(snapshot: StratagemCardsSnapshot) {
  const world = worldOf(snapshot);
  if (world.replayFormat !== 3 || !world.ruleFeatures.includes('stratagem-cards-v1'))
    fail('PRECONDITION_FAILED', '계략 패 기능을 켠 새 월드가 아닙니다.');
  const origin = world.replayOrigin;
  checkReplayOrigin(origin);
  if (
    origin.version !== 3 ||
    !isDeepStrictEqual(world.ruleFeatures, origin.initial.ruleFeatures) ||
    !isDeepStrictEqual(world.unitSet, origin.initial.unitSet)
  )
    throw Error('계략 패의 기능·병종이 원생성과 다릅니다.');
  return world;
}
function viewer(snapshot: StratagemCardsSnapshot, userId: string) {
  return snapshot.state ? (Object.values(snapshot.state.generals).find((g) => g.userId === userId)?.id ?? null) : null;
}
function requestDto(requestId: string, event: StratagemCardsRequest) {
  if (event.kind !== 'stratagem-cards.act' || event.idempotencyKey !== `stratagem-cards:${requestId}`)
    throw Error('계략 패 요청 종류·번호가 다릅니다.');
  if (event.status === 'PENDING') {
    if (event.sequence !== null || event.tick !== null || event.result !== null)
      throw Error('대기 계략 패 요청에 결과가 있습니다.');
    return { requestId, status: 'pending' as const };
  }
  validateStratagemCardsRecord({
    kind: event.kind,
    generalId: event.generalId,
    sequence: event.sequence!,
    tick: event.tick,
    status: event.status,
    payload: event.payload,
    result: event.result,
  });
  const applied = event.status === 'APPLIED' ? stratagemCardsResultSchema.parse(event.result) : null;
  return applied
    ? { requestId, status: 'applied' as const, result: { action: applied.action, tick: applied.tick } }
    : {
        requestId,
        status: 'rejected' as const,
        result: z
          .strictObject({ code: z.string(), message: z.string(), reason: z.string().optional() })
          .parse(event.result),
      };
}
export async function readStratagemCardsBoard(
  store: StratagemCardsStore,
  identity: StratagemCardsIdentity,
  value: unknown,
) {
  const input = parse(stratagemCardsWorldInput, value),
    snapshot = await store.read(identity, input.worldId),
    world = worldOf(snapshot);
  const base = { userId: identity.userId, worldId: input.worldId, status: world.status, tick: world.clockTick };
  if (!world.ruleFeatures.includes('stratagem-cards-v1'))
    return {
      ...base,
      enabled: false as const,
      capacity: 3,
      hand: [],
      traps: [],
      mine: null,
      settling: false,
      canSubmit: false,
    };
  ready(snapshot);
  if (!snapshot.state?.stratagemCards) throw Error('계략 패 조회 상태가 없습니다.');
  const view = stratagemCardsView(snapshot.state, viewer(snapshot, identity.userId), world.clockTick),
    settling = world.clockTick >= world.monthlyTick + TICKS_PER_MONTH;
  return {
    ...base,
    enabled: true as const,
    ...view,
    settling,
    canSubmit: view.mine?.canSetTrap === true && world.status === 'RUNNING' && !snapshot.sanctioned && !settling,
  };
}
export async function readStratagemCardsRequest(
  store: StratagemCardsStore,
  identity: StratagemCardsIdentity,
  value: unknown,
) {
  const input = parse(stratagemCardsRequestInput, value),
    snapshot = await store.request(identity, input.worldId, input.requestId);
  ready(snapshot);
  if (!snapshot.previous) fail('NOT_FOUND', '계략 패 요청이 없습니다.');
  return { userId: identity.userId, ...requestDto(input.requestId, snapshot.previous) };
}
export async function submitStratagemCardsRequest(
  store: StratagemCardsStore,
  identity: StratagemCardsIdentity,
  value: unknown,
) {
  const input = parse(stratagemCardsSubmitInput, value);
  if (input.expectedUserId !== identity.userId) fail('CONFLICT', '로그인 계정이 바뀌었습니다. 화면을 다시 불러오세요.');
  const event = await store.submit(identity, input.worldId, input.requestId, (snapshot) => {
    const world = ready(snapshot);
    if (snapshot.sanctioned) fail('FORBIDDEN', '이 월드의 이용이 제한됐습니다.');
    if (snapshot.previous) {
      if (
        snapshot.previous.kind !== 'stratagem-cards.act' ||
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
    const outcome = decideStratagemCardsAction(snapshot.state!, actorId, input.payload, world.clockTick);
    if (!outcome.ok)
      fail(
        ['FORBIDDEN', 'NATION_CHANGED', 'BAD_CITY'].includes(outcome.code) ? 'FORBIDDEN' : 'BAD_REQUEST',
        outcome.message,
      );
    return { enqueue: true, generalId: actorId, payload: input.payload };
  });
  return { userId: identity.userId, ...requestDto(input.requestId, event) };
}
