import { execFileSync } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';
import { createDb, type Prisma } from '../packages/db/src/index';
import { createRelationsData, initialReplayState, RELATIONS_FEATURE } from '../packages/rules/src/index';
import { cloneWorld } from '../packages/rules/src/model/clone';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease, renewLease } from '../apps/engine/src/lease';
import { exportReplay, readArchive } from '../apps/engine/src/replay';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadInitialWorldFromDb } from '../apps/engine/src/world/resources';
import { saveInitialWorld } from '../apps/engine/src/world/persistence';
import { readView } from '../apps/server/src/game/queries';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl(process.env);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
const db = createDb(url.href);

afterAll(() => db.$disconnect());

it('AC-P2-20 게시 1030 관계는 생성 원본에서 재적재·재생하고 내용 변조를 거부한다', async () => {
  const initial = await loadInitialWorldFromDb(db, { scenario: '1030', map: 'che', seed: 'relations-origin-1030' });
  expect(initial.generals).toHaveLength(491);
  expect(initialReplayState(initial).state).not.toHaveProperty('relations');
  const options = { name: '인물 관계 원본 검증', turnTermMinutes: 60, endYear: null, replayFormat: 3 } as const;
  const relations = createRelationsData(initial);
  expect(relations.pairs).toHaveLength(18);
  expect(relations.pairs.map(({ ref }) => ref)).not.toContain('J3');
  expect(relations.pairs.map(({ ref }) => ref)).not.toContain('J5');
  expect(() => createRelationsData({ ...initial, scenarioKey: '1030@2' })).toThrow('게시 시나리오 판');
  const changed = structuredClone(initial);
  changed.generals.find(({ id }) => id === relations.pairs[0]!.a.id)!.name = '다른 장수';
  expect(() => createRelationsData(changed)).toThrow('생성 장수');
  const { worldId } = await saveInitialWorld(db, initial, {
    ...options,
    ruleFeatures: [RELATIONS_FEATURE],
    featureData: { [RELATIONS_FEATURE]: relations },
  });
  try {
    const origin = readArchive(await exportReplay(db, worldId)).origin;
    const state = await loadWorld(db, worldId);
    expect(state.relations).toEqual(relations);
    expect(cloneWorld(state).relations).toEqual(relations);
    expect(cloneWorld(state).relations).not.toBe(state.relations);
    expect((await db.$transaction((tx) => readView(tx, worldId))).relations).toEqual(relations);
    expect(await db.worldExtSlice.count({ where: { worldId } })).toBe(0);

    if (origin.version !== 3) throw new Error('형식 3 생성 기록이 필요합니다.');
    const tampered = structuredClone(origin);
    tampered.featureData = {
      ...tampered.featureData,
      [RELATIONS_FEATURE]: {
        ...relations,
        pairs: [{ ...relations.pairs[0]!, kind: 'lord' }, ...relations.pairs.slice(1)],
      },
    };
    await db.world.update({ where: { id: worldId }, data: { replayOrigin: tampered as Prisma.InputJsonValue } });
    await expect(loadWorld(db, worldId)).rejects.toThrow('생성 기록과 해시');
    await expect(db.$transaction((tx) => readView(tx, worldId))).rejects.toThrow('생성 기록과 해시');
    await db.world.update({ where: { id: worldId }, data: { replayOrigin: origin as Prisma.InputJsonValue } });

    await controlClock(db, worldId, 'start');
    const lease = await acquireLease(db, worldId, undefined, 120_000);
    if (!lease) throw new Error('관계 자료 시험의 자기 실행권이 필요합니다.');
    try {
      await new TurnLoop(db, lease, { beforeCommit: (tx) => renewLease(tx, lease) }).advanceTo(10_000);
    } finally {
      await releaseLease(db, lease);
    }
    const archive = await exportReplay(db, worldId);
    expect(archive.months).toHaveLength(1);
    const replay = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import {readFileSync} from 'node:fs'; import {replayArchive} from './apps/engine/src/replay.ts'; console.log(JSON.stringify(replayArchive(JSON.parse(readFileSync(0,'utf8')),1)));",
      ],
      {
        cwd: new URL('../', import.meta.url),
        env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
        input: JSON.stringify(archive),
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    expect(JSON.parse(replay)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    expect(hashState((await loadWorld(db, worldId)).relations)).toBe(hashState(relations));
  } finally {
    await db.world.delete({ where: { id: worldId } });
  }
}, 300_000);
