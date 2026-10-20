import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import { loadInitialWorld } from './resources';
import { readWorldState, saveInitialWorld } from './persistence';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[a-z][a-z0-9_]*_test$/.test(new URL(url).pathname)) throw new Error('pnpm test:int로 전용 테스트 DB를 준비하세요.');
const db = createDb(url);
const options = { name: 'AC-M1-03 integration', turnTermMinutes: 10 };
const input = { scenario: '1030', map: 'che', seed: 'integration-seed' };

beforeAll(async () => { await db.world.deleteMany(); });
afterAll(async () => {
  await db.world.deleteMany();
  await db.$disconnect();
});

describe('AC-M1-03 실제 DB 월드 생성', () => {
  it('94개 도시·21개 국가·491명·외교 7쌍을 저장하고 재적재 해시가 같다', async () => {
    const state = await loadInitialWorld(input);
    const first = await saveInitialWorld(db, state, options);
    const second = await saveInitialWorld(db, await loadInitialWorld(input), { ...options, name: '두 번째 월드' });
    expect(second.worldId).not.toBe(first.worldId);
    for (const result of [first, second]) {
      const read = await readWorldState(db, result.worldId);
      expect([read.cities.length, read.nations.length, read.generals.length, read.diplomacies.length]).toEqual([94, 21, 491, 7]);
      expect(read).toEqual(state);
      const withPortraits = read.generals.filter((general) => general.portraitId !== null);
      expect(withPortraits.length).toBe(429);
      expect(withPortraits.length / read.generals.length).toBeGreaterThanOrEqual(0.8);
      expect(read.generals.find((general) => general.name === '조조')?.portraitId).toBe(10405);
      expect(read.generals.find((general) => general.name === '고승')?.portraitId).toBeNull();
      expect(hashState(read)).toBe(result.stateHash);
      expect(result.stateHash).toBe(hashState(state));
      const world = await db.world.findUniqueOrThrow({ where: { id: result.worldId } });
      expect(world).toMatchObject({ status: 'PREOPEN', clockTick: 0, turnTermMinutes: 10, initialStateHash: result.stateHash });
    }
  });

  it('장수 저장이 실패하면 월드·국가·도시도 모두 롤백한다', async () => {
    const state = await loadInitialWorld(input);
    state.generals[0]!.cityKey = 99999;
    const before = await Promise.all([db.world.count(), db.nation.count(), db.city.count(), db.general.count(), db.diplomacy.count()]);
    await expect(saveInitialWorld(db, state, options)).rejects.toThrow();
    expect(await Promise.all([db.world.count(), db.nation.count(), db.city.count(), db.general.count(), db.diplomacy.count()])).toEqual(before);
  });

  it('잘못된 이름과 턴 간격은 DB에 쓰기 전에 거부한다', async () => {
    const state = await loadInitialWorld(input);
    const before = await db.world.count();
    for (const turnTermMinutes of [0, -1, 0.5, NaN, 2_147_483_648]) {
      await expect(saveInitialWorld(db, state, { ...options, turnTermMinutes })).rejects.toThrow('턴 간격');
    }
    await expect(saveInitialWorld(db, state, { ...options, name: '  ' })).rejects.toThrow('월드 이름');
    expect(await db.world.count()).toBe(before);
  });

  it('DB 외래키가 다른 월드 국가·도시 참조를 거부한다', async () => {
    const state = await loadInitialWorld(input);
    const a = await saveInitialWorld(db, state, options);
    const b = await saveInitialWorld(db, state, options);
    await db.nation.create({ data: {
      worldId: b.worldId, id: 999, name: 'B에만 존재', color: '#000000', gold: 0, rice: 0,
      description: '', tech: 0, philosophy: '', level: 0,
    } });
    await expect(db.city.update({
      where: { worldId_cityKey: { worldId: a.worldId, cityKey: 1 } }, data: { nationId: 999 },
    })).rejects.toThrow();
  });

  it('CLI가 받은 설정을 저장하고 월드 ID와 실제 상태 해시를 출력한다', async () => {
    const root = new URL('../../../../', import.meta.url);
    const output = execFileSync('pnpm', ['-s', 'world:create', '--scenario', '1030', '--map', 'che',
      '--seed', 'cli-seed', '--turn-term', '7', '--name', 'CLI 통합 검증'], {
      cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 30_000,
    });
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { worldId: string; stateHash: string };
    expect(hashState(await readWorldState(db, result.worldId))).toBe(result.stateHash);
    expect(await db.world.findUniqueOrThrow({ where: { id: result.worldId } })).toMatchObject({ name: 'CLI 통합 검증', turnTermMinutes: 7 });
  });
});
