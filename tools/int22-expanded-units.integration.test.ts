import { execFileSync } from 'node:child_process';
import { afterAll, expect, it, onTestFailed } from 'vitest';
import { createDb } from '../packages/db/src/index';
import { initialReplayStateWithRegistry, ruleRegistry, runReplayAction } from '../packages/rules/src/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { acquireLease, releaseLease, renewLease, type Lease } from '../apps/engine/src/lease';
import { loadReplayState } from '../apps/engine/src/monthly';
import { exportReplay, readArchive } from '../apps/engine/src/replay';
import { TurnLoop } from '../apps/engine/src/turnLoop';
import { controlClock } from '../apps/engine/src/world/clock';
import { loadWorld } from '../apps/engine/src/worldLoader';
import { initializeSan10Resources } from './san10-resources';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('전용 테스트 DB가 필요합니다.');
const db = createDb(url);
let worldId: string | undefined;
let lease: Lease | undefined;
let failed = false;
let completedArchive: Awaited<ReturnType<typeof exportReplay>> | undefined;
afterAll(async () => {
  try {
    if (lease) await releaseLease(db, lease);
    if (worldId && !failed) await db.world.delete({ where: { id: worldId } });
  } finally {
    await db.$disconnect();
  }
});

it.sequential(
  'AC-INT-22: 실제 프리셋 생성의45병종·155거점이12개월 DB 재적재·새 루프·순수 재생과 일치한다',
  async () => {
    onTestFailed(() => {
      failed = true;
    });
    await initializeSan10Resources(db);
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/engine/src/cli/createWorld.ts',
        '--preset',
        'regular',
        '--published',
        '--seed',
        'int22-expanded-twelve-months',
        '--name',
        'AC-INT-22 실제 확장 병종',
        '--end-year',
        '300',
        '--rule-features',
        'campaign-assignment-v2,campaign-v1,city-resources-v1,five-stats,operational-map,personnel,policy,stratagem-basic,treaty',
      ],
      { cwd: new URL('../', import.meta.url), env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1)!) as { worldId: string; stateHash: string };
    worldId = result.worldId;
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId } });
    const origin = readArchive(await exportReplay(db, worldId)).origin;
    if (origin.version !== 3) throw new Error('확장 병종의 형식3 생성 원본이 필요합니다.');
    const initial = origin.initial;
    let replay = initialReplayStateWithRegistry(initial, ruleRegistry, origin.featureData);
    let sequence = 0;
    expect(world.unitSetKey).toBe('expanded');
    expect(world.ruleFeatures).toContain('battle-affinity-v2');
    expect(initial.unitSet.crewTypes).toHaveLength(45);
    expect(initial.cities).toHaveLength(155);
    expect(initial.generals).toHaveLength(491);
    expect(hashState(initial)).toBe(result.stateHash);
    await controlClock(db, worldId, 'start');
    lease = (await acquireLease(db, worldId, undefined, 120_000))!;
    expect(lease).not.toBeNull();
    // 정식 규모의 한 달이 길어져도 같은 토큰을 검사하며 매 트랜잭션에서 실행권을 갱신한다.
    const ownedLoop = (owned: Lease) => new TurnLoop(db, owned, { beforeCommit: (tx) => renewLease(tx, owned) });
    let loop = ownedLoop(lease);
    const started = performance.now();
    for (let month = 1; month <= 12; month++) {
      await renewLease(db, lease);
      await loop.advanceTo(month * 10_000);
      expect(hashState(await loadWorld(db, worldId))).toBe(hashState(loop.state));
      // 정산과 같은 tick의 장수 차례도 실행하므로 정산 직후 해시가 아닌 같은 입력 순번끼리 비교한다.
      const current = await db.world.findUniqueOrThrow({ where: { id: worldId } });
      while (sequence < current.actionSequence) {
        replay = runReplayAction(replay, initial.seed, initial.unitSet, undefined, ruleRegistry);
        sequence++;
      }
      expect(hashState(await loadReplayState(db, worldId))).toBe(hashState(replay));
      console.info(
        'INT22-month',
        JSON.stringify({ month, sequence, elapsedMs: Math.round(performance.now() - started) }),
      );
      if (month === 6) {
        await releaseLease(db, lease);
        lease = (await acquireLease(db, worldId, undefined, 120_000))!;
        loop = ownedLoop(lease);
        expect(loop.state).toBeNull();
      }
    }
    const archive = await exportReplay(db, worldId);
    expect(archive.months).toHaveLength(12);
    completedArchive = archive;
  },
  540_000,
);

it.sequential(
  'AC-INT-22: 실제 DB의12개월 원장을 별도 DB 없는 프로세스에서 재생한다',
  async () => {
    onTestFailed(() => {
      failed = true;
    });
    if (!completedArchive) throw new Error('실제 DB의 12개월 검증을 먼저 통과해야 합니다.');
    const archive = completedArchive;
    expect(archive.months).toHaveLength(12);
    const started = performance.now();
    const replayed = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { readFileSync } from 'node:fs';
         import { replayArchive } from './apps/engine/src/replay.ts';
         console.log(JSON.stringify(replayArchive(JSON.parse(readFileSync(0, 'utf8')))));`,
      ],
      {
        cwd: new URL('../', import.meta.url),
        env: { ...process.env, DATABASE_URL: '', TEST_DATABASE_URL: '' },
        input: JSON.stringify(archive),
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    expect(JSON.parse(replayed)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
    console.info(
      'INT22-replayed',
      JSON.stringify({ months: archive.months.length, elapsedMs: Math.round(performance.now() - started) }),
    );
  },
  120_000,
);
