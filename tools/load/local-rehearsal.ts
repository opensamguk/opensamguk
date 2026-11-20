// AC-M3-07: Docker 없이 지정한 기존 시험 DB에서만 수행하는 축소 측정이다.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb } from '../../packages/db/src/index';
import { buildServer } from '../../apps/server/src/server';
import { runEngine } from '../../apps/engine/src/main';
import { prepareLoadFixtures } from './fixtures';
import { runNativeLoad } from './generator';
import { LOAD_FIXTURE_POLICY } from './contract';
import { LoadHttpError } from './http';
import { nativeJournal } from './journal';
import { localRehearsalDatabaseUrl } from './server';

const db = createDb(localRehearsalDatabaseUrl(process.env.TEST_DATABASE_URL));
const controller = new AbortController();
const worldIds: string[] = [],
  userIds: string[] = [],
  engines: Promise<void>[] = [];
let server: Awaited<ReturnType<typeof buildServer>> | undefined;
const timer = setTimeout(() => controller.abort(), 360_000);
const output = resolve('.load-reports', `local-${randomUUID()}`);
let journal: ReturnType<typeof nativeJournal> | undefined;
try {
  await mkdir(output, { recursive: true });
  journal = nativeJournal(resolve(output, 'generator.jsonl'));
  const baseline = { worlds: await db.world.count(), users: await db.user.count() };
  // 로컬 리허설은 공개 약관 발행 기록을 추가하지 않는다.
  server = await buildServer({
    db,
    logging: false,
    production: false,
    secureCookies: false,
    publicOrigin: 'http://127.0.0.1:1',
    legalPolicy: {
      terms: { version: LOAD_FIXTURE_POLICY.terms.version, effectiveAt: LOAD_FIXTURE_POLICY.terms.effectiveAt },
      privacy: { version: LOAD_FIXTURE_POLICY.privacy.version, effectiveAt: LOAD_FIXTURE_POLICY.privacy.effectiveAt },
    },
    withdrawalPolicy: null,
    capacityMonitor: null,
    loginAudit: null,
    emailVerificationRequired: true,
  });
  const target = await server.listen({ host: '127.0.0.1', port: 0 });
  const fixtures = await prepareLoadFixtures(db, {
    runId: randomUUID().replaceAll('-', ''),
    target,
    origin: 'http://127.0.0.1:1',
    signal: controller.signal,
    onWorldCreated: (id) => worldIds.push(id),
    onActorPrepared: () => {},
    localRehearsal: { onUserCreated: (id) => userIds.push(id) },
    startEngine: async (worldId) => {
      const engine = runEngine(db, { worldId, signal: controller.signal });
      engines.push(engine);
      void engine.catch(() => controller.abort());
    },
  });
  const run = await runNativeLoad(fixtures.worlds, {
    mode: 'smoke',
    localRehearsal: true,
    seed: 'local-m3-rehearsal',
    signal: controller.signal,
    onEvent: journal.sink,
  });
  await journal.close();
  const measured = run.requests.filter((row) => row.phase === 'measure');
  const durations = measured.map((row) => row.durationMs).sort((a, b) => a - b);
  const summary = {
    kind: 'LOCAL_REHEARSAL_ONLY',
    node: process.version,
    baseline,
    complete: run.complete,
    measurementMs: run.measurementFinishedAt - run.measurementStartedAt,
    requests: measured.length,
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
    outcomes: Object.fromEntries(
      [...new Set(measured.map((row) => row.outcome))].map((outcome) => [
        outcome,
        measured.filter((row) => row.outcome === outcome).length,
      ]),
    ),
    failures: run.generatorFailures,
    sse: run.sse.length,
    failedSse: run.sse.filter((row) => row.failed).length,
    workers: run.workers.map((row) => row.terminal),
  };
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, output }));
  if (!run.complete) process.exitCode = 1;
} catch (error) {
  if (error instanceof LoadHttpError)
    console.error(JSON.stringify({ procedure: error.procedure, status: error.status }));
  console.error(
    error instanceof Error && /^LOAD_[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_REHEARSAL_FAILED',
  );
  process.exitCode = 1;
} finally {
  try {
    clearTimeout(timer);
    controller.abort();
    try {
      await journal?.close();
    } catch {
      process.exitCode = 1;
      console.error('LOAD_LOCAL_JOURNAL_CLOSE_FAILED');
    }
    const settled = await Promise.allSettled(engines);
    await server?.close();
    if (settled.some((row) => row.status === 'rejected')) process.exitCode = 1;
    await db.world.deleteMany({ where: { id: { in: worldIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    console.log(
      JSON.stringify({
        cleanup: true,
        ownedWorlds: worldIds.length,
        ownedUsers: userIds.length,
        remainingWorlds: await db.world.count({ where: { id: { in: worldIds } } }),
        remainingUsers: await db.user.count({ where: { id: { in: userIds } } }),
        worlds: await db.world.count(),
        users: await db.user.count(),
      }),
    );
  } finally {
    await db.$disconnect();
  }
}
