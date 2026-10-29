import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDb, type PrismaClient } from '../../packages/db/src/index';
import { TICKS_PER_MONTH, toGameDate } from '../../packages/rules/src/index';
import { initializeResources } from '../init-resources';
import { initializeIntegrationResources } from '../integration-resources';
import { prepareLoadFixtures } from './fixtures';
import { runNativeLoad } from './generator';
import { nativeJournal } from './journal';
import { writeEvidence } from './lifecycle';
import { loadDatabaseUrl } from './server';
import type { LoadRun } from './report';

export function assertActionCoverage(input: {
  worldId: string;
  lastSequence: number;
  turns: readonly { sequence: number | null; tick: number }[];
  months: readonly { sequence: number; tick: number }[];
  inputs: readonly { sequence: number | null }[];
}): LoadRun['databaseWitnesses'] {
  const seen = new Set<number>();
  const accept = (sequence: number | null) => {
    if (
      sequence === null ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > input.lastSequence ||
      seen.has(sequence)
    )
      throw new Error('LOAD_DATABASE_SEQUENCE_INVALID');
    seen.add(sequence);
    return sequence;
  };
  const witnesses: LoadRun['databaseWitnesses'] = [];
  for (const row of input.turns)
    witnesses.push({ worldId: input.worldId, sequence: accept(row.sequence), tick: row.tick, kind: 'turn' });
  for (const row of input.months)
    witnesses.push({ worldId: input.worldId, sequence: accept(row.sequence), tick: row.tick, kind: 'monthly' });
  for (const row of input.inputs) accept(row.sequence);
  if (!Number.isSafeInteger(input.lastSequence) || seen.size !== input.lastSequence)
    throw new Error('LOAD_DATABASE_SEQUENCE_MISSING');
  return witnesses.sort((a, b) => a.sequence - b.sequence);
}

export async function readDatabaseWitness(db: PrismaClient, worldIds: readonly string[], cutoffAt: number) {
  if (worldIds.length !== 2 || new Set(worldIds).size !== 2 || !Number.isFinite(cutoffAt))
    throw new Error('LOAD_DATABASE_WITNESS_INVALID');
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true)`;
      const [clock] = await tx.$queryRaw<
        Array<{ at: number }>
      >`SELECT ceil(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS at`;
      if (!clock || clock.at < cutoffAt) throw new Error('LOAD_DATABASE_WITNESS_TOO_EARLY');
      const witnesses: LoadRun['databaseWitnesses'] = [],
        coverage: LoadRun['databaseCoverage'] = [];
      for (const worldId of worldIds) {
        const world = await tx.world.findUniqueOrThrow({ where: { id: worldId } });
        if (world.clockMode !== 'REALTIME' || world.status !== 'RUNNING' || world.clockAnchorAt === null)
          throw new Error('LOAD_DATABASE_CLOCK_CHANGED');
        const [turns, months, inputs] = await Promise.all([
          tx.generalLog.findMany({
            where: { worldId, sequence: { not: null } },
            select: { sequence: true, tick: true },
          }),
          tx.yearbookSnapshot.findMany({ where: { worldId }, select: { sequence: true, tick: true } }),
          tx.inputEvent.findMany({ where: { worldId, sequence: { not: null } }, select: { sequence: true } }),
        ]);
        const own = assertActionCoverage({ worldId, lastSequence: world.actionSequence, turns, months, inputs });
        witnesses.push(...own);
        const millisecondsPerTick = (world.turnTermMinutes * 60_000) / TICKS_PER_MONTH;
        const epoch = world.clockAnchorAt.getTime() - world.clockTick * millisecondsPerTick;
        const cutoffTick = Math.ceil((cutoffAt - epoch) / millisecondsPerTick) - 1;
        const eligibleYear = toGameDate(world.startYear, world.monthlyTick + TICKS_PER_MONTH).year;
        const pendingDueTurns = await tx.general.count({
          where: { worldId, nextTurnTick: { lte: cutoffTick }, activeFromYear: { lte: eligibleYear } },
        });
        const pendingDueMonthly = Math.max(0, Math.floor((cutoffTick - world.monthlyTick) / TICKS_PER_MONTH));
        coverage.push({
          worldId,
          clockEpochAt: epoch,
          observedAt: clock.at,
          cutoffAt,
          pendingDueTurns,
          pendingDueMonthly,
          committedActionCount: own.length,
          lastSequence: world.actionSequence,
        });
      }
      return { databaseWitnesses: witnesses, databaseCoverage: coverage };
    },
    { isolationLevel: 'RepeatableRead', timeout: 15_000, maxWait: 1_000 },
  );
}

function deadline(env: NodeJS.ProcessEnv, key: string): number {
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value <= Date.now()) throw new Error('LOAD_DEADLINE_INVALID');
  return value;
}

async function main() {
  const command = process.argv[2];
  if (!['resources', 'generate', 'witness'].includes(command ?? '')) throw new Error('LOAD_WORKER_COMMAND_INVALID');
  const db = createDb(loadDatabaseUrl(process.env));
  const controller = new AbortController(),
    worldIds: string[] = [];
  let failed = false,
    journal: ReturnType<typeof nativeJournal> | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined, bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let phase = 'starting';
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const work = async () => {
    if (command === 'resources') {
      await initializeResources(
        db,
        await readFile(new URL('../../packages/db/sql/resources-init.sql', import.meta.url), 'utf8'),
      );
      controller.signal.throwIfAborted();
      await initializeIntegrationResources(db);
      controller.signal.throwIfAborted();
      return;
    }
    if (command === 'witness') {
      const fragment: unknown = JSON.parse(await readFile('/evidence/fragment.json', 'utf8'));
      if (
        !fragment ||
        typeof fragment !== 'object' ||
        !('worlds' in fragment) ||
        !Array.isArray(fragment.worlds) ||
        !('measurementFinishedAt' in fragment) ||
        typeof fragment.measurementFinishedAt !== 'number'
      )
        throw new Error('LOAD_FRAGMENT_INVALID');
      const ids = fragment.worlds.map((world: unknown) => {
        if (
          !world ||
          typeof world !== 'object' ||
          !('worldId' in world) ||
          typeof world.worldId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(world.worldId)
        )
          throw new Error('LOAD_FRAGMENT_INVALID');
        return world.worldId;
      });
      const evidence = await readDatabaseWitness(db, ids, fragment.measurementFinishedAt);
      controller.signal.throwIfAborted();
      await writeEvidence('/evidence/database-witness.json', evidence);
      return;
    }
    const runId = process.env.LOAD_RUN_ID ?? '',
      mode = process.env.LOAD_MODE;
    if (mode !== 'formal' && mode !== 'smoke') throw new Error('LOAD_MODE_INVALID');
    const setupDeadline = deadline(process.env, 'LOAD_SETUP_DEADLINE'),
      bodyDeadline = deadline(process.env, 'LOAD_BODY_DEADLINE');
    setupTimer = setTimeout(stop, setupDeadline - Date.now());
    bodyTimer = setTimeout(stop, bodyDeadline - Date.now());
    journal = nativeJournal('/evidence/generator.jsonl');
    await writeEvidence('/evidence/worker-started.json', {
      version: 1,
      runId,
      mode,
      startedAt: Date.now(),
      setupDeadline,
      bodyDeadline,
    });
    phase = 'fixtures';
    const fixtures = await prepareLoadFixtures(db, {
      runId,
      target: 'http://server:3001',
      origin: 'http://server:3001',
      signal: controller.signal,
      onWorldCreated: (id) => {
        worldIds.push(id);
      },
      startEngine: async (worldId) => {
        // 기존 실제 엔진 감독이 새 월드의 lease를 얻을 때까지 기다리며 tick은 주입하지 않는다.
        while (true) {
          controller.signal.throwIfAborted();
          const lease = await db.engineLease.findUnique({ where: { worldId } });
          controller.signal.throwIfAborted();
          if (lease && lease.expiresAt.getTime() > Date.now()) break;
          await delay(100, undefined, { signal: controller.signal });
        }
      },
    });
    controller.signal.throwIfAborted();
    phase = 'generator';
    const generator = await runNativeLoad(fixtures.worlds, {
      mode,
      seed: `load-workload-v1-${runId}`,
      signal: controller.signal,
      onEvent: async (event) => {
        controller.signal.throwIfAborted();
        if (event.kind === 'start') {
          if (event.at > setupDeadline || Date.now() > setupDeadline) throw new Error('LOAD_SETUP_DEADLINE_EXCEEDED');
          clearTimeout(setupTimer);
          await writeEvidence('/evidence/setup-completed.json', {
            completedAt: event.at,
            setupDeadline,
            worlds: 2,
            fixtureAccounts: fixtures.fixtureAccounts,
            apiHumans: fixtures.realApiHumans,
          });
          controller.signal.throwIfAborted();
        }
        await journal!.sink(event);
        controller.signal.throwIfAborted();
      },
    });
    // 중단되면 이미 얻은 부분 배열도 저장한다. 실패 원본을 성공으로 해석하지 않는다.
    const worlds = [];
    for (const world of fixtures.worlds) {
      worlds.push({
        worldId: world.worldId,
        turnTermMinutes: world.turnTermMinutes,
        generals: await db.general.count({ where: { worldId: world.worldId } }),
        humans: await db.general.count({ where: { worldId: world.worldId, userId: { not: null } } }),
      });
    }
    await writeEvidence('/evidence/fragment.json', {
      ...generator,
      worlds,
      fixtureAccounts: fixtures.fixtureAccounts,
      resourceManifest: fixtures.resourceManifest,
    });
    if (!generator.complete || controller.signal.aborted) throw new Error('LOAD_GENERATOR_INCOMPLETE');
    phase = 'due-tail';
    // 측정 끝 이전에 도래한 작업만 기다리며 시계·병력·seed·직책은 변경하지 않는다.
    while (true) {
      controller.signal.throwIfAborted();
      const evidence = await readDatabaseWitness(db, worldIds, generator.measurementFinishedAt);
      controller.signal.throwIfAborted();
      if (evidence.databaseCoverage.every((row) => row.pendingDueTurns === 0 && row.pendingDueMonthly === 0)) break;
      await delay(100, undefined, { signal: controller.signal });
    }
    await writeEvidence('/evidence/generator-completed.json', { completedAt: Date.now(), phase, complete: true });
    // 마지막 CPU 표본까지 생성기를 살아 있게 둔다. 감독은 이 전용 표식으로만 정상 반환을 요청한다.
    while (true) {
      controller.signal.throwIfAborted();
      let released = false;
      try {
        released = (await readFile('/evidence/release-worker', 'utf8')) === runId;
      } catch {
        /* 아직 요청되지 않았다. */
      }
      controller.signal.throwIfAborted();
      if (released) break;
      await delay(100, undefined, { signal: controller.signal });
    }
  };
  try {
    await work();
  } catch {
    failed = true;
    try {
      await writeEvidence('/evidence/worker-failure.json', { failed: true, phase, worldIds, at: Date.now() });
    } catch {
      /* 원 실패를 유지한다. */
    }
  } finally {
    if (setupTimer) clearTimeout(setupTimer);
    if (bodyTimer) clearTimeout(bodyTimer);
    try {
      await journal?.close();
    } catch {
      failed = true;
    }
    try {
      await db.$disconnect();
    } catch {
      failed = true;
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  if (failed) throw new Error('LOAD_WORKER_FAILED');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write('LOAD_WORKER_FAILED\n');
    process.exitCode = 1;
  }
}
