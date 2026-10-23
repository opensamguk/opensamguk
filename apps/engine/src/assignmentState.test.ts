import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Prisma } from '@opensamguk/db';
import { finishPersonnelStep, type ClosedOffer, type WorldState } from '@opensamguk/rules';
import {
  loadAssignmentState,
  persistAssignmentState,
  type AssignmentDelta,
  type AssignmentSnapshot,
} from './assignmentState';

type Offer = NonNullable<WorldState['assignmentOffers']>[number];
type Row = Prisma.AssignmentOfferGetPayload<Record<string, never>>;
const worldId = 'assignment-codec-unit-world';
const offer: Offer = {
  id: 'opaque:original',
  nationId: 1,
  issuerGeneralId: 4,
  cityKey: 2,
  createdTick: 100,
  expiresTick: 900,
};
const replacement: Offer = { ...offer, id: 'opaque:replacement', createdTick: 200 };
const empty: AssignmentSnapshot = {};

function snapshot(...entries: [number, Offer][]): AssignmentSnapshot {
  return { assignmentOffers: Object.fromEntries(entries) };
}

function row(targetGeneralId = 7, value = offer, changes: Partial<Row> = {}): Row {
  return {
    worldId,
    targetGeneralId,
    ...value,
    status: 'PENDING',
    resolvedBy: null,
    cancelReason: null,
    resolvedTick: null,
    ...changes,
  };
}

function closure(id = offer.id): Extract<ClosedOffer, { status: 'ACCEPTED' }> & { resolvedBy: 'RESPONSE' } {
  return { id, status: 'ACCEPTED', resolvedBy: 'RESPONSE', cancelReason: null, resolvedTick: 200 };
}

function delta(
  before = empty,
  final = before,
  closedOffers: readonly ClosedOffer[] = [],
  beforeFinish = final,
): AssignmentDelta {
  return { before, beforeFinish, final, closedOffers };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function harness() {
  // 실제 접속을 요청하거나 코덱 밖 표를 읽으면 시험이 실패한다.
  const db = createDb('postgresql://assignment_unit:unused@127.0.0.1:1/never_connect');
  const forbidden = new Error('발령 코덱 범위 밖의 DB 호출입니다.');
  return {
    db,
    find: vi.spyOn(db.assignmentOffer, 'findMany').mockResolvedValue([]),
    create: vi.spyOn(db.assignmentOffer, 'create').mockResolvedValue(row()),
    update: vi.spyOn(db.assignmentOffer, 'updateMany').mockResolvedValue({ count: 1 }),
    guards: [
      vi.spyOn(db, '$connect').mockRejectedValue(forbidden),
      vi.spyOn(db, '$transaction').mockRejectedValue(forbidden),
      vi.spyOn(db, '$executeRaw').mockRejectedValue(forbidden),
      vi.spyOn(db, '$executeRawUnsafe').mockRejectedValue(forbidden),
      vi.spyOn(db, '$queryRaw').mockRejectedValue(forbidden),
      vi.spyOn(db, '$queryRawUnsafe').mockRejectedValue(forbidden),
      vi.spyOn(db.assignmentOffer, 'delete').mockRejectedValue(forbidden),
      vi.spyOn(db.assignmentOffer, 'deleteMany').mockRejectedValue(forbidden),
      vi.spyOn(db.assignmentOffer, 'upsert').mockRejectedValue(forbidden),
      vi.spyOn(db.assignmentOffer, 'update').mockRejectedValue(forbidden),
      vi.spyOn(db.assignmentOffer, 'createMany').mockRejectedValue(forbidden),
      vi.spyOn(db.nationOffice, 'findMany').mockRejectedValue(forbidden),
      vi.spyOn(db.nationOfficeTurn, 'findMany').mockRejectedValue(forbidden),
      vi.spyOn(db.nationTurn, 'findMany').mockRejectedValue(forbidden),
    ],
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(async () => {
  for (const guard of h.guards) expect(guard).not.toHaveBeenCalled();
  await h.db.$disconnect();
  vi.restoreAllMocks();
});

function noWrites() {
  expect(h.create).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
}

function seed(before: AssignmentSnapshot) {
  h.find.mockResolvedValue(
    Object.entries(before.assignmentOffers ?? {}).map(([target, value]) => row(Number(target), value)),
  );
}

describe('발령 제안 적재', () => {
  it('행이 없으면 선택 키를 생략하고 PENDING만 조회한다', async () => {
    expect(await loadAssignmentState(h.db, worldId)).toEqual({});
    expect(h.find).toHaveBeenCalledExactlyOnceWith({
      where: { worldId, status: 'PENDING' },
      orderBy: [{ targetGeneralId: 'asc' }, { id: 'asc' }],
    });
    noWrites();
  });

  it('대상 순서와 원래 id를 보존하며 DB 전용 필드를 빼고 복제한다', async () => {
    const rows = freeze([row(9, replacement), row(7)]);
    h.find.mockResolvedValue(rows);
    const result = await loadAssignmentState(h.db, worldId);
    expect(Object.keys(result.assignmentOffers!)).toEqual(['7', '9']);
    expect(result).toEqual(snapshot([7, offer], [9, replacement]));
    expect(result.assignmentOffers![7]).not.toBe(rows[1]);
    expect(result.assignmentOffers![7]).not.toBe(offer);
    noWrites();
  });

  it.each([
    ['대상 중복', [row(), row(7, replacement)]],
    ['id 중복', [row(), row(9)]],
    ['다른 월드', [row(7, offer, { worldId: 'other' })]],
    ['종료된 상태', [row(7, offer, { status: 'ACCEPTED' })]],
    ['해결 방식', [row(7, offer, { resolvedBy: 'RESPONSE' })]],
    ['취소 사유', [row(7, offer, { cancelReason: 'CITY_LOST' })]],
    ['종료 tick', [row(7, offer, { resolvedTick: 200 })]],
    ['대상 0', [row(0)]],
    ['국가 음수', [row(7, { ...offer, nationId: -1 })]],
    ['발령자 소수', [row(7, { ...offer, issuerGeneralId: 1.5 })]],
    ['도시 범위 초과', [row(7, { ...offer, cityKey: 2_147_483_648 })]],
    ['생성 tick 음수', [row(7, { ...offer, createdTick: -1 })]],
    ['기한 tick 무한대', [row(7, { ...offer, expiresTick: Infinity })]],
    ['빈 id', [row(7, { ...offer, id: '' })]],
    ['문자열 아닌 id', [row(7, { ...offer, id: 3 as unknown as string })]],
  ] as const)('%s 행을 거부한다', async (_name, rows) => {
    h.find.mockResolvedValue([...rows]);
    await expect(loadAssignmentState(h.db, worldId)).rejects.toThrow();
    noWrites();
  });
});

describe('발령 제안 차이 저장', () => {
  it.each([empty, { assignmentOffers: {} }, snapshot([7, offer])])('변화가 없으면 조회만 한다 (%j)', async (state) => {
    seed(state);
    await persistAssignmentState(h.db, worldId, delta(state));
    expect(h.find).toHaveBeenCalledTimes(1);
    noWrites();
  });

  it('새 제안은 원본 필드와 PENDING만 삽입한다', async () => {
    await persistAssignmentState(h.db, worldId, delta(empty, snapshot([7, offer])));
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      data: { worldId, targetGeneralId: 7, ...offer, status: 'PENDING' },
    });
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    closure(),
    { ...closure(), resolvedBy: 'EXPIRY' },
    { ...closure(), status: 'REJECTED' },
    { ...closure(), status: 'SUPERSEDED', resolvedBy: null },
    ...(['CITY_LOST', 'TARGET_LEFT', 'ISSUER_LOST_OFFICE'] as const).map((cancelReason): ClosedOffer => ({
      ...closure(),
      status: 'CANCELLED',
      resolvedBy: null,
      cancelReason,
    })),
  ] satisfies ClosedOffer[])('합법 종료 조합을 PENDING 조건으로 한 번 적용한다 (%j)', async (closed) => {
    const before = snapshot([7, offer]);
    seed(before);
    await persistAssignmentState(h.db, worldId, delta(before, empty, [closed]));
    const { id, ...data } = closed;
    expect(h.update).toHaveBeenCalledExactlyOnceWith({ where: { worldId, id, status: 'PENDING' }, data });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('같은 대상의 기존 제안을 닫고 새 제안을 삽입한 뒤 즉시 취소한다', async () => {
    const before = snapshot([7, offer]);
    seed(before);
    const oldClosed: ClosedOffer = { ...closure(), status: 'SUPERSEDED', resolvedBy: null };
    const newClosed: ClosedOffer = {
      ...closure(replacement.id),
      status: 'CANCELLED',
      resolvedBy: null,
      cancelReason: 'TARGET_LEFT',
    };
    const input = freeze(delta(before, empty, [newClosed, oldClosed], snapshot([7, replacement])));
    const preserved = structuredClone(input);
    await persistAssignmentState(h.db, worldId, input);
    expect(h.update.mock.calls.map(([args]) => args.where)).toEqual([
      { worldId, id: offer.id, status: 'PENDING' },
      { worldId, id: replacement.id, status: 'PENDING' },
    ]);
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0]!);
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.update.mock.invocationCallOrder[1]!);
    expect(input).toEqual(preserved);
  });

  it('교체 뒤 남는 새 제안은 기존 종료보다 먼저 삽입하지 않는다', async () => {
    const before = snapshot([7, offer]);
    seed(before);
    await persistAssignmentState(
      h.db,
      worldId,
      delta(before, snapshot([7, replacement]), [{ ...closure(), status: 'SUPERSEDED', resolvedBy: null }]),
    );
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0]!);
  });

  it('종료 기록 입력 순서와 관계없이 대상 순서로 쓴다', async () => {
    const other = { ...offer, id: 'opaque:other' };
    const before = snapshot([9, other], [7, offer]);
    seed(before);
    await persistAssignmentState(h.db, worldId, delta(before, empty, [closure(other.id), closure()]));
    expect(h.update.mock.calls.map(([args]) => args.where?.id)).toEqual([offer.id, other.id]);
    h.update.mockClear();
    h.find.mockResolvedValue([]);
    await persistAssignmentState(h.db, worldId, delta(empty, before));
    expect(h.create.mock.calls.map(([args]) => args.data.targetGeneralId)).toEqual([7, 9]);
  });

  it('실제 마무리에서 사라진 새 제안도 증인으로 삽입한 뒤 닫는다', async () => {
    const before: WorldState = {
      startYear: 191,
      cities: {},
      generals: {},
      diplomacies: [],
      nations: {
        1: {
          id: 1,
          name: '국가',
          color: '#123456',
          gold: 0,
          rice: 0,
          description: '',
          tech: 0,
          philosophy: '',
          level: 0,
          capitalCityKey: 1,
          isNpc: false,
        },
      },
    };
    const change = freeze({ state: { ...before, assignmentOffers: { 7: offer } }, closedOffers: [], logs: [] });
    const beforeFinish = structuredClone(change.state);
    const result = finishPersonnelStep(freeze(before), change, {}, 200);
    expect(result.state.assignmentOffers).toBeUndefined();
    expect(result.closedOffers).toEqual([
      { ...closure(), status: 'CANCELLED', resolvedBy: null, cancelReason: 'CITY_LOST' },
    ]);
    const input = freeze(delta(before, result.state, result.closedOffers, beforeFinish));
    await persistAssignmentState(h.db, worldId, input);
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      data: { worldId, targetGeneralId: 7, ...offer, status: 'PENDING' },
    });
    expect(h.update).toHaveBeenCalledExactlyOnceWith({
      where: { worldId, id: offer.id, status: 'PENDING' },
      data: { status: 'CANCELLED', resolvedBy: null, cancelReason: 'CITY_LOST', resolvedTick: 200 },
    });
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.update.mock.invocationCallOrder[0]!);
  });
});

describe('발령 제안 사전 거부', () => {
  const before = snapshot([7, offer]);
  it.each([
    ['빠진 종료', delta(before, empty), '종료 기록이 빠졌습니다'],
    ['남은 제안 종료', delta(before, before, [closure()]), '종료 기록이 상태와 다릅니다'],
    ['없는 id 종료', delta(empty, empty, [closure()]), '종료 기록이 상태와 다릅니다'],
    ['종료 id 중복', delta(before, empty, [closure(), closure()]), '종료 기록이 상태와 다릅니다'],
    ['증인 누락', delta(before, empty, [closure(), closure(replacement.id)]), '종료 기록이 상태와 다릅니다'],
    ['최종에만 있는 제안', delta(empty, before, [], empty), '마무리 전 증인'],
    ['최종 원본 정보 변경', delta(empty, snapshot([7, { ...offer, cityKey: 3 }]), [], before), '마무리 전 증인'],
    ['같은 id 대상 변경', delta(before, snapshot([9, offer])), '생성 정보'],
    ['국가 변경', delta(before, snapshot([7, { ...offer, nationId: 2 }])), '생성 정보'],
    ['발령자 변경', delta(before, snapshot([7, { ...offer, issuerGeneralId: 9 }])), '생성 정보'],
    ['도시 변경', delta(before, snapshot([7, { ...offer, cityKey: 3 }])), '생성 정보'],
    ['생성 tick 변경', delta(before, snapshot([7, { ...offer, createdTick: 101 }])), '생성 정보'],
    ['기한 tick 변경', delta(before, snapshot([7, { ...offer, expiresTick: 901 }])), '생성 정보'],
    ['map 안 id 중복', delta(snapshot([7, offer], [9, offer])), 'id가 중복'],
    ['음수 대상 키', delta(snapshot([-1, offer])), '정수 저장 범위'],
    ['비정규 대상 키', delta({ assignmentOffers: { '07': offer } } as AssignmentSnapshot), '대상 키'],
    ['빈 id', delta(snapshot([7, { ...offer, id: '' }])), 'id가 올바르지'],
    ['알 수 없는 제안 필드', delta(snapshot([7, { ...offer, extra: true } as Offer])), '필드'],
    ['빠진 제안 필드', delta(snapshot([7, { id: offer.id } as Offer])), '필드'],
    ['생성보다 이른 종료', delta(before, empty, [{ ...closure(), resolvedTick: 99 }]), '종료 tick'],
    ['소수 종료 tick', delta(before, empty, [{ ...closure(), resolvedTick: 100.5 }]), '정수 저장 범위'],
    ['종료 tick 초과', delta(before, empty, [{ ...closure(), resolvedTick: 2_147_483_648 }]), '정수 저장 범위'],
    ['종료 필드 추가', delta(before, empty, [{ ...closure(), extra: 1 } as unknown as ClosedOffer]), '필드'],
    ['종료 필드 누락', delta(before, empty, [{ id: offer.id } as ClosedOffer]), '필드'],
    ['목록 아닌 종료', { ...delta(), closedOffers: {} } as AssignmentDelta, '종료 목록'],
    [
      '같은 대상의 중간 제안 손실',
      delta(before, snapshot([7, replacement]), [
        { ...closure(), status: 'SUPERSEDED', resolvedBy: null },
        closure('opaque:lost-intermediate'),
      ]),
      '종료 기록이 상태와 다릅니다',
    ],
  ] as const)('%s 경우 조회나 쓰기 전에 거부한다', async (_name, input, expected) => {
    await expect(persistAssignmentState(h.db, worldId, freeze(input))).rejects.toThrow(expected);
    expect(h.find).not.toHaveBeenCalled();
    noWrites();
  });

  it.each([
    { status: 'PENDING', resolvedBy: null },
    { status: 'ACCEPTED', resolvedBy: null },
    { status: 'REJECTED', resolvedBy: 'EXPIRY' },
    { status: 'SUPERSEDED', resolvedBy: 'RESPONSE' },
    { status: 'CANCELLED', resolvedBy: null },
    { status: 'ACCEPTED', cancelReason: 'CITY_LOST' },
    { status: 'CANCELLED', resolvedBy: null, cancelReason: 'OTHER' },
  ])('금지된 종료 조합을 거부한다 (%j)', async (changes) => {
    const closed = { ...closure(), ...changes } as ClosedOffer;
    await expect(persistAssignmentState(h.db, worldId, delta(before, empty, [closed]))).rejects.toThrow(
      '종료 상태 조합',
    );
    expect(h.find).not.toHaveBeenCalled();
    noWrites();
  });
});

describe('발령 제안 DB 대조와 오류 전파', () => {
  it.each([
    ['사라진 PENDING', []],
    ['추가 PENDING', [row(), row(9, replacement)]],
    ['바뀐 원본', [row(7, { ...offer, cityKey: 3 })]],
  ] as const)('%s이면 조건부 갱신 전에 실패한다', async (_name, rows) => {
    h.find.mockResolvedValue([...rows]);
    await expect(
      persistAssignmentState(h.db, worldId, delta(snapshot([7, offer]), empty, [closure()])),
    ).rejects.toThrow('before');
    noWrites();
  });

  it.each([0, 2])('조건부 갱신 count %i이면 후속 삽입 없이 실패한다', async (count) => {
    const before = snapshot([7, offer]);
    seed(before);
    h.update.mockResolvedValue({ count });
    await expect(
      persistAssignmentState(
        h.db,
        worldId,
        delta(before, snapshot([7, replacement]), [{ ...closure(), status: 'SUPERSEDED', resolvedBy: null }]),
      ),
    ).rejects.toThrow('한 행');
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('새 제안의 종료도 count 1이 아니면 실패한다', async () => {
    h.update.mockResolvedValue({ count: 0 });
    await expect(
      persistAssignmentState(h.db, worldId, delta(empty, empty, [closure()], snapshot([7, offer]))),
    ).rejects.toThrow('한 행');
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(1);
  });

  it('삽입 오류를 그대로 던지고 다시 삽입하거나 닫지 않는다', async () => {
    const failure = new Error('시험 기본키 충돌');
    h.create.mockRejectedValue(failure);
    const input = freeze(delta(empty, empty, [closure()], snapshot([7, offer])));
    const preserved = structuredClone(input);
    await expect(persistAssignmentState(h.db, worldId, input)).rejects.toBe(failure);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
    expect(input).toEqual(preserved);
  });

  it('조회와 갱신 오류를 각각 그대로 전파한다', async () => {
    const failure = new Error('시험 DB 오류');
    h.find.mockRejectedValueOnce(failure);
    await expect(persistAssignmentState(h.db, worldId, delta())).rejects.toBe(failure);
    noWrites();
    const before = snapshot([7, offer]);
    seed(before);
    h.update.mockRejectedValue(failure);
    await expect(persistAssignmentState(h.db, worldId, delta(before, empty, [closure()]))).rejects.toBe(failure);
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
  });
});
