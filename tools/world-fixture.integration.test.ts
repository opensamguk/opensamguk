import { afterAll, expect, it } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  applyRecordedInput,
  checkReplayOrigin,
  initialReplayState,
  type RecordedInput,
} from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { saveFixtureWorld, attachFixtureOwners } from '../e2e/worldFixture';
import { commandInitial } from '../packages/rules/test/commandFixture';
import { loadReplayState } from '../apps/engine/src/monthly';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl(process.env).href;
const db = createDb(url);
afterAll(() => db.$disconnect());

it('AC-INT-27·28 고정물의 소유자 부착은 생성 기록을 보존하고 엔진 재적재 해시와 같다', async () => {
  const user = await db.user.create({
    data: { email: `${crypto.randomUUID()}@example.test`, passwordHash: 'fixture-only' },
  });
  let worldId: string | undefined;
  try {
    const initial = commandInitial();
    initial.generals[0]!.userId = user.id;
    const original = structuredClone(initial);
    const saved = await saveFixtureWorld(db, initial, {
      name: 'INT27 고정물 재생',
      turnTermMinutes: 60,
      endYear: null,
    });
    worldId = saved.worldId;
    expect(initial).toEqual(original);
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const origin: unknown = world.replayOrigin;
    checkReplayOrigin(origin);
    expect(hashState(origin.initial)).toBe(saved.stateHash);
    expect(origin.initial.generals.every((g) => g.userId === null && g.crew === 0)).toBe(true);
    let replay = initialReplayState(origin.initial, origin.version === 3 ? origin.featureData : undefined);
    const inputs = await db.inputEvent.findMany({ where: { worldId }, orderBy: { sequence: 'asc' } });
    expect(inputs).toHaveLength(1);
    for (const input of inputs) {
      const record = {
        sequence: input.sequence!,
        tick: input.tick,
        generalId: input.generalId,
        kind: input.kind,
        status: input.status,
        payload: input.payload,
        result: input.result,
      } as RecordedInput;
      replay = applyRecordedInput(replay, record);
    }
    const loaded = await db.$transaction((tx) => loadReplayState(tx, worldId!));
    expect(loaded).toEqual(replay);
    expect(hashState(loaded)).toBe(hashState(replay));
    await expect(attachFixtureOwners(db, worldId, [{ id: initial.generals[1]!.id, userId: user.id }])).rejects.toThrow(
      '고정물 NPC 맡기 실패',
    );
    expect(await db.inputEvent.count({ where: { worldId } })).toBe(1);
  } finally {
    if (worldId) await db.world.delete({ where: { id: worldId } });
    await db.user.delete({ where: { id: user.id } });
  }
});
