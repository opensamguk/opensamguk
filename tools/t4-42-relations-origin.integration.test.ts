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
import { composeInitialWorld, readInitialResources } from '../apps/engine/src/world/resources';
import { savePreparedInitialWorld } from '../apps/engine/src/world/persistence';
import { createWorldFromCli } from '../apps/engine/src/admin/creation';
import { prepareWorldReset } from '../apps/engine/src/admin/resetPreparation';
import { readView } from '../apps/server/src/game/queries';
import { testDatabaseUrl } from './test-database';

const url = testDatabaseUrl(process.env);
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('loopback 시험 서버가 필요합니다.');
const db = createDb(url.href);

afterAll(() => db.$disconnect());

it('AC-P2-20 게시 1030 관계는 생성 원본에서 재적재·재생하고 내용 변조를 거부한다', async () => {
  const resources = await readInitialResources(db, { scenario: '1030', map: 'che' });
  const initial = composeInitialWorld(resources, 'relations-origin-1030');
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
  const { worldId } = await createWorldFromCli(
    db,
    initial,
    { ...options, ruleFeatures: [RELATIONS_FEATURE] },
    resources,
  );
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

    const alteredInitial = structuredClone(origin);
    alteredInitial.initial.generals.find(({ id }) => id === relations.pairs[0]!.a.id)!.gold += 1;
    await db.world.update({ where: { id: worldId }, data: { replayOrigin: alteredInitial as Prisma.InputJsonValue } });
    await expect(loadWorld(db, worldId)).rejects.toThrow('생성 기록과 해시');
    await expect(db.$transaction((tx) => readView(tx, worldId))).rejects.toThrow('생성 기록과 해시');

    await db.world.update({
      where: { id: worldId },
      data: { replayOrigin: origin as Prisma.InputJsonValue, initialStateHash: hashState(alteredInitial.initial) },
    });
    await expect(loadWorld(db, worldId)).rejects.toThrow('생성 기록과 해시');
    await expect(db.$transaction((tx) => readView(tx, worldId))).rejects.toThrow('생성 기록과 해시');
    await db.world.update({ where: { id: worldId }, data: { initialStateHash: origin.initialStateHash } });

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

it('AC-P2-20 초기화는 이전 원본의 관계 사본을 새 월드에 보존한다', async () => {
  const resources = await readInitialResources(db, { scenario: '1030', map: 'che' });
  const initial = composeInitialWorld(resources, 'relations-reset-source');
  const current = createRelationsData(initial);
  const archived = {
    ...current,
    pairs: [{ ...current.pairs[0]!, kind: 'lord' as const }, ...current.pairs.slice(1)],
  };
  expect(archived).not.toEqual(current);
  const source = await createWorldFromCli(
    db,
    initial,
    {
      name: '과거 관계 원본 초기화',
      turnTermMinutes: 60,
      endYear: null,
      replayFormat: 3,
      ruleFeatures: [RELATIONS_FEATURE],
      featureData: { [RELATIONS_FEATURE]: archived },
    },
    resources,
  );
  const ids = [source.worldId];
  try {
    const reset = await prepareWorldReset(db, source.worldId, 'relations-reset-target', new AbortController().signal);
    const target = await db.$transaction((tx) => savePreparedInitialWorld(tx, reset.prepared));
    ids.push(target.worldId);
    expect(target.stateHash).not.toBe(source.stateHash);
    const origin = readArchive(await exportReplay(db, target.worldId)).origin;
    if (origin.version !== 3) throw new Error('형식 3 초기화 원본이 필요합니다.');
    expect(origin.resourceHash).toBe(reset.evidence.sourceResourceHash);
    expect(origin.featureData?.[RELATIONS_FEATURE]).toEqual(archived);
    expect((await loadWorld(db, target.worldId)).relations).toEqual(archived);
  } finally {
    await db.world.deleteMany({ where: { id: { in: ids } } });
  }
}, 60_000);
