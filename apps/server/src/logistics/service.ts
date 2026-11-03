import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  applyLogisticsInput,
  checkReplayOrigin,
  findLogisticsPath,
  logisticsCapacity,
  logisticsResultSchema,
  logisticsTotal,
  TICKS_PER_MONTH,
  validateLogisticsRecord,
  unitSetSchema,
} from '@opensamguk/rules';
import type { LogisticsIdentity, LogisticsRequest, LogisticsSnapshot, LogisticsStore } from './ports';
import { logisticsBoardInput, logisticsRequestInput, logisticsSubmitInput } from './schemas';

type FailureCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'FORBIDDEN' | 'BAD_REQUEST' | 'CONFLICT' | 'PRECONDITION_FAILED';
export class LogisticsServiceError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: FailureCode, message: string): never {
  throw new LogisticsServiceError(code, message);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail('BAD_REQUEST', '물류 입력을 확인하세요.');
  return result.data;
}
function ready(snapshot: LogisticsSnapshot) {
  if (!snapshot.authenticated) fail('UNAUTHORIZED', '로그인이 필요합니다.');
  const world = snapshot.world;
  if (!world) fail('NOT_FOUND', '월드가 없습니다.');
  if (world.replayFormat !== 3 || !world.ruleFeatures.includes('logistics-v1'))
    fail('PRECONDITION_FAILED', '이 월드에서 물류 기능을 사용할 수 없습니다.');
  const origin = world.replayOrigin;
  checkReplayOrigin(origin);
  if (
    origin.version !== 3 ||
    !isDeepStrictEqual(world.ruleFeatures, origin.initial.ruleFeatures) ||
    !isDeepStrictEqual(world.unitSet, origin.initial.unitSet)
  )
    throw new Error('물류의 기능·운영 병종이 원생성과 다릅니다.');
  return world;
}
function requestDto(requestId: string, event: LogisticsRequest) {
  if (event.kind !== 'logistics.order' || event.idempotencyKey !== `logistics:${requestId}`)
    throw new Error('물류 요청의 종류·번호가 다릅니다.');
  if (event.status === 'PENDING') {
    if (event.sequence !== null || event.tick !== null || event.result !== null)
      throw new Error('대기 물류 요청의 결과가 있습니다.');
    return { requestId, status: 'pending' as const };
  }
  validateLogisticsRecord({
    kind: event.kind,
    generalId: event.generalId,
    status: event.status,
    sequence: event.sequence!,
    tick: event.tick,
    payload: event.payload,
    result: event.result,
  });
  return event.status === 'APPLIED'
    ? { requestId, status: 'applied' as const, result: logisticsResultSchema.parse(event.result) }
    : {
        requestId,
        status: 'rejected' as const,
        result: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }).parse(event.result),
      };
}

export async function readLogisticsRequest(store: LogisticsStore, identity: LogisticsIdentity, value: unknown) {
  const input = parse(logisticsRequestInput, value);
  const snapshot = await store.request(identity, input.worldId, input.requestId);
  ready(snapshot);
  if (!snapshot.previous) fail('NOT_FOUND', '물류 요청이 없습니다.');
  return { userId: identity.userId, ...requestDto(input.requestId, snapshot.previous) };
}
export async function submitLogisticsRequest(store: LogisticsStore, identity: LogisticsIdentity, value: unknown) {
  const input = parse(logisticsSubmitInput, value);
  if (input.expectedUserId !== identity.userId) fail('CONFLICT', '로그인 계정이 바뀌었습니다. 화면을 다시 불러오세요.');
  const event = await store.submit(identity, input.worldId, input.requestId, (snapshot) => {
    const world = ready(snapshot);
    if (snapshot.sanctioned) fail('FORBIDDEN', '이 월드의 이용이 제한됐습니다.');
    if (snapshot.previous) {
      if (snapshot.previous.kind !== 'logistics.order' || !isDeepStrictEqual(snapshot.previous.payload, input.payload))
        fail('CONFLICT', '같은 요청 번호로 다른 내용을 보냈습니다.');
      return { enqueue: false };
    }
    if (world.status !== 'RUNNING') fail('PRECONDITION_FAILED', '실행 중인 월드가 아닙니다.');
    if (world.clockTick >= world.monthlyTick + TICKS_PER_MONTH)
      fail('CONFLICT', '월 정산이 진행 중입니다. 완료 뒤 다시 보내세요.');
    if (!snapshot.state?.logistics) throw new Error('물류 판정 상태가 없습니다.');
    const actor = Object.values(snapshot.state.generals).find((general) => general.userId === identity.userId);
    if (!actor) fail('NOT_FOUND', '장수가 없습니다.');
    if (input.expectedGeneralId !== undefined && actor.id !== input.expectedGeneralId)
      fail('CONFLICT', '조작 장수가 바뀌었습니다. 화면을 다시 불러오세요.');
    const outcome = applyLogisticsInput(snapshot.state, input.payload, actor.id, {
      tick: world.clockTick,
      userId: identity.userId,
      userActive: true,
    });
    if (!outcome.ok)
      fail(
        ['ACTOR_INACTIVE', 'NO_PERMISSION', 'NOT_OWN_CITY'].includes(outcome.code) ? 'FORBIDDEN' : 'BAD_REQUEST',
        outcome.message,
      );
    return { enqueue: true, generalId: actor.id, payload: input.payload };
  });
  return { userId: identity.userId, ...requestDto(input.requestId, event) };
}

export async function readLogisticsBoard(store: LogisticsStore, identity: LogisticsIdentity, value: unknown) {
  const input = parse(logisticsBoardInput, value);
  const snapshot = await store.read(identity, input.worldId, input.cityKey);
  const world = ready(snapshot),
    state = snapshot.state;
  if (!state?.logistics) throw new Error('물류 조회 상태가 없습니다.');
  const actor = Object.values(state.generals).find((general) => general.userId === identity.userId);
  if (!actor) fail('NOT_FOUND', '장수가 없습니다.');
  const city = state.cities[input.cityKey];
  if (!city) fail('NOT_FOUND', '거점이 없습니다.');
  const own = actor.nationId !== null && actor.nationId === city.nationId;
  const base = { userId: identity.userId, actorId: actor.id, cityKey: input.cityKey };
  if (!own && actor.cityKey !== city.cityKey) return { ...base, visible: false as const };
  const specialty = state.logistics.config.specialties.find((row) => row.cityKey === city.cityKey) ?? null;
  if (!own) return { ...base, visible: true as const, own: false as const, specialty };
  const config = state.logistics.config,
    stock = state.logistics.cities[String(city.cityKey)]!;
  const settling = world.clockTick >= world.monthlyTick + TICKS_PER_MONTH;
  const year = state.startYear + Math.floor(world.clockTick / (12 * TICKS_PER_MONTH));
  const canManage =
    world.status === 'RUNNING' &&
    !snapshot.sanctioned &&
    actor.activeFromYear <= year &&
    actor.officerLevel >= 5 &&
    actor.officerLevel <= 12;
  const destinations = Object.values(state.cities)
    .filter((target) => target.nationId === actor.nationId && target.cityKey !== city.cityKey)
    .sort((a, b) => a.cityKey - b.cityKey)
    .flatMap((target) => {
      const path = findLogisticsPath(state, city.cityKey, target.cityKey, actor.nationId!, config.transport.maxHops);
      if (!path) return [];
      return [
        {
          cityKey: target.cityKey,
          name: target.name,
          freeCapacity:
            logisticsCapacity(config, state.logistics!.cities[String(target.cityKey)]!.level) -
            logisticsTotal(state.logistics!.cities[String(target.cityKey)]!),
          path,
          arriveTick:
            (Math.floor(world.clockTick / TICKS_PER_MONTH) +
              Math.ceil((path.length - 1) / config.transport.hopsPerMonth)) *
            TICKS_PER_MONTH,
          lossBp: Math.min(10_000, (path.length - 1) * config.transport.lossBpPerHop),
        },
      ];
    });
  return {
    ...base,
    visible: true as const,
    own: true as const,
    status: world.status,
    canManage: canManage && !settling && city.supplied,
    settling,
    tick: world.clockTick,
    revision: state.logistics.revision,
    specialty,
    resources: { ...stock },
    capacity: logisticsCapacity(config, stock.level),
    used: logisticsTotal(stock),
    gold: state.cityResources!.cities[String(city.cityKey)]!.gold,
    recruitUnits: unitSetSchema
      .parse(world.unitSet)
      .crewTypes.filter((unit) => unit.armType > 0)
      .map(({ id, armType, name }) => ({ id, armType, name })),
    costs: structuredClone({
      upgrade: config.upgrade,
      capacity: config.capacity,
      trade: config.trade,
      recruitPer100: config.recruitPer100,
      build: config.build,
      transport: config.transport,
    }),
    destinations,
    convoys: structuredClone(state.logistics.convoys.filter((convoy) => convoy.nationId === actor.nationId)),
    movements: structuredClone(snapshot.movements),
  };
}
