import { providedRuleKeys } from '../packages/rules/src/providedRules';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, expect, it, onTestFailed } from 'vitest';
import { createDb } from '../packages/db/src/index';
import {
  initialReplayStateWithRegistry,
  applyRecordedInput,
  ruleRegistry,
  runArchiveReplayAction,
  type RecordedInput,
  type WorldInit,
} from '../packages/rules/src/index';
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
let execution: Promise<void> | undefined;
const lifetime = new AbortController();
let completedArchive: Awaited<ReturnType<typeof exportReplay>> | undefined;
let initial: WorldInit;
let replay: ReturnType<typeof initialReplayStateWithRegistry>;
let sequence = 0;
let loop: TurnLoop;
let completedMonth = 0;
let started = 0;
// 같은 정식 월드를 한 번 만들고 매 TX에서 자기 실행권을 갱신한다.
const ownedLoop = (owned: Lease) => new TurnLoop(db, owned, { beforeCommit: (tx) => renewLease(tx, owned) });

beforeEach(async () => {
  await execution?.catch(() => undefined);
  lifetime.signal.throwIfAborted();
});

afterAll(async () => {
  lifetime.abort();
  await execution?.catch(() => undefined);
  try {
    if (lease) await releaseLease(db, lease);
    if (worldId) await db.world.delete({ where: { id: worldId } });
  } finally {
    await db.$disconnect();
  }
});

it(
  'AC-INT-22: 실제 프리셋의45병종·155거점·491명을 한 번 생성한다',
  () =>
    (execution = (async () => {
      onTestFailed(() => {
        lifetime.abort();
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
        ],
        { cwd: new URL('../', import.meta.url), env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
      );
      const result = JSON.parse(output.trim().split('\n').at(-1)!) as { worldId: string; stateHash: string };
      worldId = result.worldId;
      const world = await db.world.findUniqueOrThrow({ where: { id: worldId! } });
      const origin = readArchive(await exportReplay(db, worldId)).origin;
      if (origin.version !== 3) throw new Error('확장 병종의 형식3 생성 원본이 필요합니다.');
      initial = origin.initial;
      replay = initialReplayStateWithRegistry(initial, ruleRegistry, origin.featureData);
      sequence = 0;
      expect(world.unitSetKey).toBe('expanded');
      expect(providedRuleKeys).toContain('battle-affinity-v2');
      expect(initial.unitSet.crewTypes).toHaveLength(45);
      expect(initial.cities).toHaveLength(155);
      expect(initial.generals).toHaveLength(491);
      expect(hashState(initial)).toBe(result.stateHash);
      await controlClock(db, worldId, 'start');
      lease = (await acquireLease(db, worldId!, undefined, 120_000))!;
      expect(lease).not.toBeNull();
      // 정식 규모의 한 달이 길어져도 같은 토큰을 검사하며 매 트랜잭션에서 실행권을 갱신한다.
      loop = ownedLoop(lease);
      started = performance.now();
    })()),
  60_000,
);

// 155거점·491명 12개월차 실측 414.3초(전술 입력 270건, 엔진 376.9초 + 검증 37.4초).
// 같은 월드를 12개월 이어 쓰며 전체 작업·해시 대조를 유지할 월별 한도는 600초다.
for (let month = 1; month <= 12; month++) {
  it(
    `AC-INT-22: 정식 ${month}개월 DB 재적재·새 루프·순수 재생이 일치한다`,
    () =>
      (execution = (async () => {
        onTestFailed(() => lifetime.abort());
        const monthStarted = performance.now();
        if (completedMonth !== month - 1) throw new Error('앞선 정식 월 검증이 끝나지 않았습니다.');
        lifetime.signal.throwIfAborted();
        await renewLease(db, lease!);
        await loop.advanceTo(month * 10_000, lifetime.signal);
        const advancedAt = performance.now();
        expect(hashState(await loadWorld(db, worldId!))).toBe(hashState(loop.state));
        // 정산과 같은 tick의 장수 차례도 실행하므로 정산 직후 해시가 아닌 같은 입력 순번끼리 비교한다.
        const current = await db.world.findUniqueOrThrow({ where: { id: worldId! } });
        // 늘 켠 전술의 battle.step도 작업 순번을 쓴다. 장수·정산만 실행하면 첫 전투부터 재생이 어긋난다.
        const events = await db.inputEvent.findMany({
          where: { worldId, sequence: { gt: sequence, lte: current.actionSequence } },
          orderBy: { sequence: 'asc' },
        });
        const inputs = new Map<number, RecordedInput>();
        for (const event of events) {
          if (event.status === 'PENDING' || event.sequence === null) throw new Error('완료된 재생 입력이 필요합니다.');
          inputs.set(event.sequence, {
            sequence: event.sequence,
            generalId: event.generalId,
            kind: event.kind,
            status: event.status,
            payload: event.payload,
            result: event.result,
            tick: event.tick,
          });
        }
        while (sequence < current.actionSequence) {
          lifetime.signal.throwIfAborted();
          // 원생성 재생 대조가 길어져도 자기 토큰의 유효성을 검사하며 갱신한다.
          if (sequence % 64 === 0) await renewLease(db, lease!);
          const input = inputs.get(++sequence);
          // 이 루프만 소유한 재생 상태는 보관 재생과 같이 비실행 장수의 예턴을 재사용한다.
          replay = input
            ? applyRecordedInput(replay, input, ruleRegistry, { unitSet: initial.unitSet })
            : runArchiveReplayAction(replay, initial.seed, initial.unitSet, ruleRegistry);
        }
        expect(hashState(await loadReplayState(db, worldId!))).toBe(hashState(replay));
        console.info(
          'INT22-month',
          JSON.stringify({
            month,
            sequence,
            inputs: events.length,
            inputKinds: [...new Set(events.map((event) => event.kind))],
            engineMs: Math.round(advancedAt - monthStarted),
            verificationMs: Math.round(performance.now() - advancedAt),
            monthMs: Math.round(performance.now() - monthStarted),
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
        if (month === 6) {
          await releaseLease(db, lease!);
          lease = (await acquireLease(db, worldId!, undefined, 120_000))!;
          loop = ownedLoop(lease);
          expect(loop.state).toBeNull();
        }
        lifetime.signal.throwIfAborted();
        completedMonth = month;
      })()),
    600_000,
  );
}

// 실제 12개 월 정산 체크포인트의 수출·원장 재생 실측 250.9초. 월 진행과 나눠 600초를 둔다.
it(
  'AC-INT-22: 실제 DB의 12개월 원장을 한 번 수출한다',
  () =>
    (execution = (async () => {
      if (completedMonth !== 12) throw new Error('12개월 DB·재생 검증이 먼저 필요합니다.');
      const exportStarted = performance.now();
      const archive = await exportReplay(db, worldId!);
      expect(archive.months).toHaveLength(12);
      completedArchive = archive;
      console.info(
        'INT22-exported',
        JSON.stringify({ months: archive.months.length, elapsedMs: Math.round(performance.now() - exportStarted) }),
      );
    })()),
  600_000,
);

// DB 없는 별도 프로세스의 실제 12개월 재생 실측 241.3초. 모든 월 해시를 대조하며 600초를 둔다.
it('AC-INT-22: 실제 DB의12개월 원장을 별도 DB 없는 프로세스에서 재생한다', async () => {
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
      timeout: 600_000,
    },
  );
  expect(JSON.parse(replayed)).toEqual(archive.months.map(({ tick, stateHash }) => ({ tick, stateHash })));
  console.info(
    'INT22-replayed',
    JSON.stringify({ months: archive.months.length, elapsedMs: Math.round(performance.now() - started) }),
  );
}, 600_000);
