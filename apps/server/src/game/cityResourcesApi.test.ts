import type { PrismaClient } from '@opensamguk/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCityResourceInput } from '@opensamguk/rules';
import { readView, requireGeneral, requireWorld } from './queries';
import { requirePersonnelSession } from './personnelAdmission';
import { readCityResourceBoard, readCityResourceRequest, submitCityResourceRequest } from './cityResourcesApi';

vi.mock('./queries', async (original) => ({
  ...(await original<typeof import('./queries')>()),
  readView: vi.fn(),
  requireWorld: vi.fn(),
  requireGeneral: vi.fn(),
}));
vi.mock('./personnelAdmission', () => ({ requirePersonnelSession: vi.fn() }));
vi.mock('@opensamguk/rules', async (original) => ({
  ...(await original<typeof import('@opensamguk/rules')>()),
  checkReplayOrigin: vi.fn(),
  campaignArmyTypes: vi.fn(() => [1100]),
  applyCityResourceInput: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());
const requestId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const otherUserId = '10000000-0000-4000-8000-000000000003';
function fixture() {
  const payload = { cityKey: 1, unitId: 1, crewType: 1100, amount: 50 };
  const actor = { id: 2, nationId: 1, officerLevel: 12, cityKey: 1, activeFromYear: 191 };
  const view = {
    cityResources: {
      version: 1,
      cities: {
        '1': { gold: 400, rice: 500, garrison: [{ crewType: 1100, troops: 200, train: 50, atmos: 60 }] },
        '2': { gold: 9999, rice: 8888, garrison: [] },
      },
    },
    cities: { 1: { cityKey: 1, nationId: 1 }, 2: { cityKey: 2, nationId: 2 } },
    generals: {
      2: { ...actor, name: '지휘관', leadership: 60 },
      3: { id: 3, nationId: 1, cityKey: 2, activeFromYear: 191, name: '먼 장수', leadership: 60 },
    },
    campaign: {
      units: [
        { id: 1, ownerId: 2, commanderId: 2, troops: 100, crewType: 1100, train: 50, atmos: 60 },
        { id: 2, ownerId: 3, commanderId: 3, troops: 100, crewType: 1100, train: 50, atmos: 60 },
      ],
    },
  };
  const initial = { ruleFeatures: ['city-resources-v1'], unitSet: { crewTypes: [{ id: 1100, name: '보병' }] } };
  const world = {
    id: 'own-world',
    ruleFeatures: ['city-resources-v1'],
    replayFormat: 3,
    replayOrigin: { version: 3, initial },
    unitSet: initial.unitSet,
    startYear: 191,
    clockTick: 200,
    status: 'RUNNING',
  };
  let saved: object | null = null;
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    sanction: { findFirst: vi.fn(async (): Promise<object | null> => null) },
    inputEvent: {
      findUnique: vi.fn(async () => saved),
      create: vi.fn(async (input: { data: object }) => {
        saved = { ...input.data, status: 'PENDING' };
        return saved;
      }),
    },
  };
  const ctx = {
    db: { $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) } as unknown as PrismaClient,
    user: { id: userId },
    sessionId: 'own-session',
    now: 1000,
  };
  vi.mocked(requireWorld).mockResolvedValue(world as unknown as Awaited<ReturnType<typeof requireWorld>>);
  vi.mocked(requireGeneral).mockResolvedValue(actor as unknown as Awaited<ReturnType<typeof requireGeneral>>);
  vi.mocked(readView).mockResolvedValue(view as unknown as Awaited<ReturnType<typeof readView>>);
  vi.mocked(applyCityResourceInput).mockReturnValue({
    ok: true,
    state: {},
    result: {},
    text: '',
  } as unknown as ReturnType<typeof applyCityResourceInput>);
  const run = () => submitCityResourceRequest(ctx, { worldId: world.id, requestId, expectedUserId: userId, payload });
  return {
    ctx,
    tx,
    view,
    world,
    actor,
    payload,
    run,
    setSaved: (value: object | null) => {
      saved = value;
    },
  };
}
describe('AC-INT-18B 도시 자원 API 접수', () => {
  it('세션 행위자를 검증하고 InputEvent·활동만 한 번 접수한다', async () => {
    const f = fixture(),
      before = structuredClone(f.view);
    expect(await f.run()).toEqual({ requestId, status: 'pending' });
    expect(requireGeneral).toHaveBeenCalledWith(expect.anything(), 'own-world', userId, true);
    expect(requireWorld).toHaveBeenCalledWith(expect.anything(), 'own-world', true);
    expect(applyCityResourceInput).toHaveBeenCalledWith(
      f.view,
      f.payload,
      2,
      expect.objectContaining({ tick: 200, userId: userId, userActive: true }),
    );
    expect(f.tx.inputEvent.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        worldId: 'own-world',
        userId: userId,
        generalId: 2,
        kind: 'city.resources',
        payload: f.payload,
        sequence: null,
      }),
    });
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(f.view).toEqual(before);
    await f.run();
    expect(f.tx.inputEvent.create).toHaveBeenCalledTimes(1);
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it('같은 계정 요청 번호의 다른 내용은 CONFLICT다', async () => {
    const f = fixture();
    await f.run();
    f.payload.amount++;
    await expect(f.run()).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.tx.inputEvent.create).toHaveBeenCalledTimes(1);
  });
  it('예상 계정이 mutation 세션과 다르면 접수·활동 입력을 만들지 않는다', async () => {
    const f = fixture();
    f.ctx.user.id = otherUserId;
    await expect(f.run()).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.ctx.db.$transaction).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('조회 뒤 쿠키 계정이 바뀌면 이전 화면의 계정으로 접수할 수 없다', async () => {
    const f = fixture();
    expect(await readCityResourceBoard(f.ctx, 'own-world', 1)).toMatchObject({ visible: true, canAllocate: true });
    f.ctx.user.id = otherUserId;
    await expect(f.run()).rejects.toHaveProperty('code', 'CONFLICT');
    f.ctx.user.id = userId;
    await expect(
      submitCityResourceRequest(f.ctx, {
        worldId: 'own-world',
        requestId,
        expectedUserId: otherUserId,
        payload: f.payload,
      }),
    ).rejects.toHaveProperty('code', 'CONFLICT');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'own-user'])('예상 계정 UUID가 없거나 잘못되면 거부한다 (%s)', async (expectedUserId) => {
    const f = fixture();
    await expect(
      submitCityResourceRequest(f.ctx, {
        worldId: 'own-world',
        requestId,
        expectedUserId: expectedUserId as string,
        payload: f.payload,
      }),
    ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(f.ctx.db.$transaction).not.toHaveBeenCalled();
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it('UUID·전역 revision·행위자 주입을 엄격히 거부한다', async () => {
    const f = fixture();
    await expect(
      submitCityResourceRequest(f.ctx, {
        worldId: 'own-world',
        expectedUserId: userId,
        requestId: 'invalid',
        payload: f.payload,
      }),
    ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    for (const extra of [{ revision: 0 }, { userId: 'other' }, { generalId: 99 }])
      await expect(
        submitCityResourceRequest(f.ctx, {
          worldId: 'own-world',
          expectedUserId: userId,
          requestId,
          payload: { ...f.payload, ...extra },
        }),
      ).rejects.toHaveProperty('code', 'BAD_REQUEST');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it('세션 만료·제재·월드 상태를 다시 확인한다', async () => {
    const f = fixture();
    vi.mocked(requirePersonnelSession).mockRejectedValueOnce(new Error('session-expired'));
    await expect(f.run()).rejects.toThrow('session-expired');
    f.tx.sanction.findFirst.mockResolvedValueOnce({ id: 'sanction' });
    await expect(f.run()).rejects.toHaveProperty('code', 'FORBIDDEN');
    f.world.status = 'ENDED';
    await expect(f.run()).rejects.toHaveProperty('code', 'PRECONDITION_FAILED');
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it.each(['PROTECTED', 'ACTOR_INACTIVE', 'NOT_NATION', 'NOT_OWN_CITY'])(
    '사전 규칙 거부 %s는 권한 오류다',
    async (code) => {
      const f = fixture();
      vi.mocked(applyCityResourceInput).mockReturnValue({ ok: false, code, message: '권한 거부' });
      await expect(f.run()).rejects.toHaveProperty('code', 'FORBIDDEN');
      expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
    },
  );
  it('도시 부족·병종·집결 거부는 접수하지 않는다', async () => {
    const f = fixture();
    for (const code of ['NO_CREW', 'NO_UNIT_SET', 'BAD_STATE']) {
      vi.mocked(applyCityResourceInput).mockReturnValue({ ok: false, code, message: '배속 불가' });
      await expect(f.run()).rejects.toHaveProperty('code', 'BAD_REQUEST');
    }
    expect(f.tx.inputEvent.create).not.toHaveBeenCalled();
  });
  it('결과 조회는 월드와 자기 계정의 요청 키만 검색한다', async () => {
    const f = fixture();
    await expect(readCityResourceRequest(f.ctx, 'own-world', requestId)).rejects.toHaveProperty('code', 'NOT_FOUND');
    expect(f.tx.inputEvent.findUnique).toHaveBeenCalledWith({
      where: {
        worldId_userId_idempotencyKey: {
          worldId: 'own-world',
          userId: userId,
          idempotencyKey: `city.resources:${requestId}`,
        },
      },
    });
  });
  it('확정 결과만 엄격하게 읽고 처리 tick이 다른 기록은 실패한다', async () => {
    const f = fixture();
    const event = {
      idempotencyKey: `city.resources:${requestId}`,
      kind: 'city.resources',
      generalId: 2,
      sequence: 9,
      tick: 200,
      payload: f.payload,
      status: 'APPLIED',
      result: { ...f.payload, revision: 1, tick: 200 },
    };
    f.setSaved(event);
    expect(await readCityResourceRequest(f.ctx, 'own-world', requestId)).toEqual({
      requestId,
      status: 'applied',
      result: event.result,
    });
    f.setSaved({ ...event, result: { ...event.result, tick: 201 } });
    await expect(readCityResourceRequest(f.ctx, 'own-world', requestId)).rejects.toThrow('tick');
    f.setSaved({ ...event, status: 'REJECTED', result: { code: 'NO_CREW', message: '병력 부족' } });
    expect(await readCityResourceRequest(f.ctx, 'own-world', requestId)).toEqual({
      requestId,
      status: 'rejected',
      result: { code: 'NO_CREW', message: '병력 부족' },
    });
  });
  it('생성 기록의 기능 사본이 바뀐 월드는 읽지 않는다', async () => {
    const f = fixture();
    f.world.replayOrigin.initial.ruleFeatures = [];
    await expect(readCityResourceBoard(f.ctx, 'own-world', 1)).rejects.toThrow('기능 사본');
    expect(readView).not.toHaveBeenCalled();
  });
});
describe('AC-INT-18B 도시 원장 가시성과 배속 대상', () => {
  it('다른 국가의 먼 도시 금·쌀·병력을 반환하지 않는다', async () => {
    const f = fixture();
    expect(await readCityResourceBoard(f.ctx, 'own-world', 2)).toEqual({ cityKey: 2, visible: false });
  });
  it('자국 도시는 원장을 읽고 권한자는 같은 도시에 집결한 자국 부곡만 본다', async () => {
    const f = fixture();
    const board = await readCityResourceBoard(f.ctx, 'own-world', 1);
    expect(board).toMatchObject({
      visible: true,
      canAllocate: true,
      resources: f.view.cityResources.cities['1'],
      targets: [{ id: 1, ownerName: '지휘관', commanderName: '지휘관', capacity: 6000, commanded: 100 }],
    });
    expect(board.visible && board.targets).toHaveLength(1);
  });
  it('현재 거점이 적국이면 원장은 보이지만 배속 대상은 숨긴다', async () => {
    const f = fixture();
    f.actor.cityKey = 2;
    const board = await readCityResourceBoard(f.ctx, 'own-world', 2);
    expect(board).toMatchObject({
      visible: true,
      canAllocate: false,
      targets: [],
      resources: f.view.cityResources.cities['2'],
    });
  });
  it.each([0, 4, 13])('직책 %i는 배속 대상을 보지 못한다', async (level) => {
    const f = fixture();
    f.actor.officerLevel = level;
    expect(await readCityResourceBoard(f.ctx, 'own-world', 1)).toMatchObject({
      visible: true,
      canAllocate: false,
      targets: [],
    });
  });
  it('없는 도시는 NOT_FOUND다', async () => {
    const f = fixture();
    await expect(readCityResourceBoard(f.ctx, 'own-world', 99)).rejects.toHaveProperty('code', 'NOT_FOUND');
  });
  it('등장 전 장수와 종료된 판은 배속 대상으로 조작할 수 없다', async () => {
    const f = fixture();
    f.actor.activeFromYear = 192;
    expect(await readCityResourceBoard(f.ctx, 'own-world', 1)).toMatchObject({
      visible: true,
      canAllocate: false,
      targets: [],
    });
    f.actor.activeFromYear = 191;
    f.world.status = 'ENDED';
    expect(await readCityResourceBoard(f.ctx, 'own-world', 1)).toMatchObject({
      visible: true,
      canAllocate: false,
      targets: [],
    });
  });
});
