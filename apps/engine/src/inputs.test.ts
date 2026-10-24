import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@opensamguk/db';
import { ruleRegistry } from '@opensamguk/rules';
import { processInputs, queuedInputHandlers } from './inputs';
import {
  checkWorldReplay,
  engineRegistry,
  type EngineRegistry,
  type EngineWorld,
  type QueuedInputHandler,
} from './features';
import { featureRegistry, featureArchive } from '../test/replayFeaturesFixture';

function registry(handler: QueuedInputHandler): EngineRegistry {
  return {
    rules: featureRegistry,
    features: featureRegistry.features.map((feature) => ({
      key: feature.key,
      queuedInputs: { [`${feature.key}.queued`]: handler },
    })),
  };
}
function fixture(kind = 'test-a.queued', features = ['test-a']) {
  const world = { id: 'world', replayFormat: 3, ruleFeatures: features } as EngineWorld;
  const event = { id: 1n, kind, status: 'PENDING', worldId: world.id };
  const tx = {
    inputEvent: { findFirst: vi.fn(async () => event), updateMany: vi.fn(async () => ({ count: 1 })) },
    world: { update: vi.fn(async () => ({ actionSequence: 7 })) },
  };
  return { world, tx, client: tx as unknown as Prisma.TransactionClient };
}
describe('T2-26 통합 입력 처리기', () => {
  it('운영 대기 종류는 핵심 처리기 하나와 일치한다', () => {
    expect(engineRegistry.features).toEqual([]);
    expect(Object.keys(queuedInputHandlers()).sort()).toEqual(
      ruleRegistry.inputKinds
        .filter((kind) => kind.route === 'queued')
        .map((kind) => kind.kind)
        .sort(),
    );
  });
  it('종류와 상관없이 첫 PENDING을 받아 sequence·tick을 한 번만 쓴다', async () => {
    const { world, tx, client } = fixture();
    const handler = vi.fn<QueuedInputHandler>(async () => ({ status: 'APPLIED', result: { ok: true }, generalId: 2 }));
    expect(await processInputs(client, world, 123, registry(handler))).toBe(true);
    expect(tx.inputEvent.findFirst).toHaveBeenCalledWith({
      where: { worldId: 'world', status: 'PENDING' },
      orderBy: { id: 'asc' },
    });
    expect(handler).toHaveBeenCalledWith(client, world, expect.objectContaining({ id: 1n }), {
      tick: 123,
      sequence: 7,
    });
    expect(tx.world.update).toHaveBeenCalledTimes(1);
    expect(tx.inputEvent.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 1n, status: 'PENDING' },
      data: { status: 'APPLIED', result: { ok: true }, generalId: 2, sequence: 7, tick: 123 },
    });
  });
  it('기능이 꺼졌으면 처리기를 부르지 않고 확정 거절한다', async () => {
    const { world, tx, client } = fixture('test-a.queued', []);
    const handler = vi.fn<QueuedInputHandler>();
    await processInputs(client, world, 12, registry(handler));
    expect(handler).not.toHaveBeenCalled();
    expect(tx.inputEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: 'REJECTED',
          result: { code: 'FEATURE_DISABLED', message: '이 월드에서 켜지 않은 기능입니다.' },
          sequence: 7,
          tick: 12,
        },
      }),
    );
  });
  it.each(['unknown', 'turns.set'])('%s는 sequence를 받기 전에 멈춘다', async (kind) => {
    const { world, tx, client } = fixture(kind);
    await expect(processInputs(client, world, 0)).rejects.toThrow('종류');
    expect(tx.world.update).not.toHaveBeenCalled();
    expect(tx.inputEvent.updateMany).not.toHaveBeenCalled();
  });
  it('조건부 갱신 실패는 호출자 트랜잭션을 취소한다', async () => {
    const { world, tx, client } = fixture();
    tx.inputEvent.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      processInputs(
        client,
        world,
        0,
        registry(async () => ({ status: 'REJECTED', result: { code: 'TEST' } })),
      ),
    ).rejects.toThrow('저장을 취소');
  });
  it('형식 1 처리 tick은 수출 대상이 아니다', async () => {
    const { world, tx, client } = fixture();
    world.replayFormat = 1;
    await processInputs(
      client,
      world,
      0,
      registry(async () => ({ status: 'REJECTED', result: {} })),
    );
    expect(tx.inputEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tick: null }) }),
    );
  });
  it('처리기 누락·중복·즉시 종류·다른 소속을 거부한다', () => {
    const handler: QueuedInputHandler = async () => ({ status: 'REJECTED', result: {} });
    const source = registry(handler);
    const cases: EngineRegistry[] = [
      { ...source, features: [] },
      { ...source, features: [...source.features, source.features[0]!] },
      { ...source, features: [{ key: 'test-a', queuedInputs: { 'turns.set': handler } }] },
      { ...source, features: [{ key: 'test-a', queuedInputs: { 'test-b.queued': handler } }] },
      { rules: { ...ruleRegistry, inputKinds: [] }, features: [] },
    ];
    for (const value of cases) expect(() => queuedInputHandlers(value)).toThrow();
  });
});

describe('T2-26 엔진 시작 대조와 서버 기능 확인', () => {
  it('형식 1의 null 원본만 허용한다', () => {
    expect(() => checkWorldReplay({ replayOrigin: null, replayFormat: 1, ruleFeatures: [] })).not.toThrow();
    for (const value of [
      { replayFormat: 3, ruleFeatures: [] },
      { replayFormat: 1, ruleFeatures: ['test-a'] },
    ])
      expect(() => checkWorldReplay({ replayOrigin: null, ...value })).toThrow();
  });
  it('S2~S5는 형식·기능 사본과 생성 기록을 대조한다', async () => {
    const archive = await featureArchive(['test-a']);
    const world = {
      replayOrigin: archive.origin as unknown as Prisma.JsonValue,
      replayFormat: 3,
      ruleFeatures: ['test-a'],
    };
    expect(() => checkWorldReplay(world, featureRegistry)).not.toThrow();
    expect(() => checkWorldReplay({ ...world, replayFormat: 1 }, featureRegistry)).toThrow();
    expect(() => checkWorldReplay({ ...world, ruleFeatures: [] }, featureRegistry)).toThrow();
    expect(() => checkWorldReplay(world)).toThrow('모르는');
    archive.origin.initialStateHash = 'not checked at startup';
    expect(() => checkWorldReplay(world, featureRegistry)).not.toThrow();
    for (const version of [2, 4, 5])
      expect(() =>
        checkWorldReplay(
          { ...world, replayOrigin: { ...archive.origin, version } as unknown as Prisma.JsonValue },
          featureRegistry,
        ),
      ).toThrow();
  });
});
