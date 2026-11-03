import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  checkReplayOrigin,
  decideGovernanceAction,
  governanceLedgerScope,
  governanceResultSchema,
  governanceView,
  TICKS_PER_MONTH,
  validateGovernanceRecord,
  visibleGovernanceMovements,
} from '@opensamguk/rules';
import type { GovernanceIdentity, GovernanceRequest, GovernanceSnapshot, GovernanceStore } from './ports';
import { governanceRequestInput, governanceSubmitInput, governanceWorldInput } from './schemas';

type FailureCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED';
export class GovernanceServiceError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: FailureCode, message: string): never {
  throw new GovernanceServiceError(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('BAD_REQUEST', '황실 요청 인자가 잘못되었습니다.');
  return result.data;
}
function ready(snapshot: GovernanceSnapshot) {
  if (!snapshot.authenticated) fail('UNAUTHORIZED', '로그인이 필요합니다.');
  const world = snapshot.world;
  if (!world) fail('NOT_FOUND', '월드가 없습니다.');
  if (world.replayFormat !== 3 || !world.ruleFeatures.includes('governance-v1'))
    fail('PRECONDITION_FAILED', '황실 기능을 켠 새 월드가 아닙니다.');
  const origin = world.replayOrigin;
  checkReplayOrigin(origin);
  if (
    origin.version !== 3 ||
    !isDeepStrictEqual(world.ruleFeatures, origin.initial.ruleFeatures) ||
    !isDeepStrictEqual(world.unitSet, origin.initial.unitSet)
  )
    throw new Error('황실의 기능·병종이 원생성과 다릅니다.');
  return world;
}
function requestDto(requestId: string, event: GovernanceRequest) {
  if (event.kind !== 'governance.act' || event.idempotencyKey !== `governance:${requestId}`)
    throw new Error('황실 요청 종류·번호가 다릅니다.');
  if (event.status === 'PENDING') {
    if (event.sequence !== null || event.tick !== null || event.result !== null)
      throw new Error('대기 황실 요청에 결과가 있습니다.');
    return { requestId, status: 'pending' as const };
  }
  validateGovernanceRecord({
    kind: event.kind,
    generalId: event.generalId,
    sequence: event.sequence!,
    tick: event.tick,
    status: event.status,
    payload: event.payload,
    result: event.result,
  });
  return event.status === 'APPLIED'
    ? { requestId, status: 'applied' as const, result: governanceResultSchema.parse(event.result) }
    : {
        requestId,
        status: 'rejected' as const,
        result: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).parse(event.result),
      };
}
function viewer(snapshot: GovernanceSnapshot, userId: string) {
  return snapshot.state
    ? (Object.values(snapshot.state.generals).find((general) => general.userId === userId)?.id ?? null)
    : null;
}
export async function readGovernanceBoard(store: GovernanceStore, identity: GovernanceIdentity, value: unknown) {
  const input = parse(governanceWorldInput, value);
  const snapshot = await store.read(identity, input.worldId, (current) => {
    const world = ready(current);
    if (!current.state?.governance) throw new Error('황실 조회 상태가 없습니다.');
    return governanceLedgerScope(current.state, viewer(current, identity.userId), world.clockTick);
  });
  const world = ready(snapshot);
  if (!snapshot.state?.governance) throw new Error('황실 조회 상태가 없습니다.');
  const actorId = viewer(snapshot, identity.userId),
    settling = world.clockTick >= world.monthlyTick + TICKS_PER_MONTH;
  return {
    userId: identity.userId,
    worldId: input.worldId,
    status: world.status,
    tick: world.clockTick,
    settling,
    canSubmit: actorId !== null && world.status === 'RUNNING' && !snapshot.sanctioned && !settling,
    view: governanceView(snapshot.state, actorId, world.clockTick),
    movements: visibleGovernanceMovements(snapshot.state, actorId, world.clockTick, snapshot.movements),
  };
}
export async function readGovernanceRequest(store: GovernanceStore, identity: GovernanceIdentity, value: unknown) {
  const input = parse(governanceRequestInput, value),
    snapshot = await store.request(identity, input.worldId, input.requestId);
  ready(snapshot);
  if (!snapshot.previous) fail('NOT_FOUND', '황실 요청이 없습니다.');
  return { userId: identity.userId, ...requestDto(input.requestId, snapshot.previous) };
}
export async function submitGovernanceRequest(store: GovernanceStore, identity: GovernanceIdentity, value: unknown) {
  const input = parse(governanceSubmitInput, value);
  if (input.expectedUserId !== identity.userId) fail('CONFLICT', '로그인 계정이 바뀌었습니다. 화면을 다시 불러오세요.');
  const event = await store.submit(identity, input.worldId, input.requestId, (snapshot) => {
    const world = ready(snapshot);
    if (snapshot.sanctioned) fail('FORBIDDEN', '이 월드의 이용이 제한됐습니다.');
    if (snapshot.previous) {
      if (snapshot.previous.kind !== 'governance.act' || !isDeepStrictEqual(snapshot.previous.payload, input.payload))
        fail('CONFLICT', '같은 요청 번호로 다른 내용을 보냈습니다.');
      return { enqueue: false };
    }
    if (world.status !== 'RUNNING') fail('PRECONDITION_FAILED', '실행 중인 월드가 아닙니다.');
    if (world.clockTick >= world.monthlyTick + TICKS_PER_MONTH)
      fail('CONFLICT', '월 정산이 진행 중입니다. 완료 뒤 다시 보내세요.');
    const actorId = viewer(snapshot, identity.userId);
    if (actorId === null) fail('NOT_FOUND', '장수가 없습니다.');
    if (input.expectedGeneralId !== undefined && actorId !== input.expectedGeneralId)
      fail('CONFLICT', '조작 장수가 바뀌었습니다. 화면을 다시 불러오세요.');
    const outcome = decideGovernanceAction(snapshot.state!, actorId, input.payload, world.clockTick);
    if (!outcome.ok)
      fail(
        ['NO_AUTHORITY', 'NOT_PARTY', 'NO_ACTOR', 'NOT_NATION'].includes(outcome.code) ? 'FORBIDDEN' : 'BAD_REQUEST',
        outcome.message,
      );
    return { enqueue: true, generalId: actorId, payload: input.payload };
  });
  return { userId: identity.userId, ...requestDto(input.requestId, event) };
}
