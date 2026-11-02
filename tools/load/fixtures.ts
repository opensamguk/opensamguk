import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PrismaClient } from '../../packages/db/src/index';
import { hashPassword } from '../../apps/server/src/auth/password';
import { newSession } from '../../apps/server/src/auth/session';
import { composeInitialWorld, readInitialResources } from '../../apps/engine/src/world/resources';
import { saveInitialWorld } from '../../apps/engine/src/world/persistence';
import { controlClock } from '../../apps/engine/src/world/clock';
import {
  LOAD_CONTRACT,
  LOAD_FEATURES,
  LOAD_FIXTURE_POLICY,
  LOAD_RESOURCES,
  loadDatabaseName,
  loadWorldPlans,
} from './contract';
import { assertLoadProfile, loadResourceManifest } from './profile';
import { LoadHttpClient, loadOrigin } from './http';
import { activateOwnedLoadWorld } from './fixtureLifecycle';

export type LoadActor = Readonly<{ userId: string; generalId: number; worldId: string; client: LoadHttpClient }>;
export type LoadFixtureOptions = {
  runId: string;
  target: string;
  origin: string;
  signal: AbortSignal;
  // L4 소유자가 실제 감독/엔진 프로세스를 기동·추적한다. 진행 tick을 직접 주입하지 않는다.
  startEngine: (worldId: string) => Promise<void>;
  onWorldCreated: (worldId: string) => void;
};

export async function prepareLoadFixtures(db: PrismaClient, options: LoadFixtureOptions) {
  loadOrigin(options.target);
  loadOrigin(options.origin);
  const expectedName = loadDatabaseName(options.runId);
  options.signal.throwIfAborted();
  const [identity] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (identity?.name !== expectedName || (await db.world.count()) !== 0 || (await db.user.count()) !== 0)
    throw new Error('LOAD_FRESH_DEDICATED_DATABASE_REQUIRED');
  const resources = await readInitialResources(db, LOAD_RESOURCES);
  const resourceManifest = loadResourceManifest(resources);
  options.signal.throwIfAborted();
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const worlds = [];
  for (const plan of loadWorldPlans(options.runId)) {
    options.signal.throwIfAborted();
    const initial = composeInitialWorld(resources, plan.seed);
    const profile = assertLoadProfile(initial);
    initial.ruleFeatures = [...LOAD_FEATURES];
    const { worldId } = await activateOwnedLoadWorld(
      () =>
        saveInitialWorld(db, initial, {
          name: `부하 ${plan.label}`,
          turnTermMinutes: plan.turnTermMinutes,
          endYear: 201,
        }),
      { ...options, startClock: (id) => controlClock(db, id, 'start') },
    );
    const actors: LoadActor[] = [];
    for (const name of plan.humanNames) {
      options.signal.throwIfAborted();
      const userId = randomUUID();
      const now = new Date();
      const session = newSession(now.getTime());
      await db.user.create({
        data: {
          id: userId,
          email: `load-${userId}@example.invalid`,
          passwordHash,
          emailVerifiedAt: now,
          consents: {
            create: [
              { docType: 'TERMS', version: LOAD_FIXTURE_POLICY.terms.version, agreedAt: now },
              { docType: 'PRIVACY', version: LOAD_FIXTURE_POLICY.privacy.version, agreedAt: now },
            ],
          },
          sessions: { create: { id: session.id, expiresAt: session.expiresAt } },
        },
      });
      options.signal.throwIfAborted();
      const client = new LoadHttpClient(options.target, options.origin, session.token);
      const created = await client.request(
        'general.create',
        {
          worldId,
          name,
          leadership: 55,
          strength: 55,
          intel: 55,
          politics: 55,
          charm: 55,
          portraitId: null,
        },
        options.signal,
      );
      options.signal.throwIfAborted();
      let generalId = created.data.status === 'created' ? created.data.general.id : undefined;
      const deadline = performance.now() + 30_000;
      while (generalId === undefined && performance.now() < deadline) {
        options.signal.throwIfAborted();
        const mine = await client.request('general.mine', { worldId }, options.signal);
        options.signal.throwIfAborted();
        if (mine.data.general) generalId = mine.data.general.id;
        else if (mine.data.creation?.status === 'rejected') throw new Error('LOAD_API_CREATION_REJECTED');
        else await delay(100, undefined, { signal: options.signal });
      }
      if (!Number.isSafeInteger(generalId)) throw new Error('LOAD_API_CREATION_NOT_APPLIED');
      const row = await db.general.findUniqueOrThrow({ where: { worldId_userId: { worldId, userId } } });
      const event = await db.inputEvent.findFirst({
        where: { worldId, userId, kind: 'general.create', status: 'APPLIED' },
      });
      if (
        row.id !== generalId ||
        !event ||
        (await db.generalTurn.count({ where: { worldId, generalId: row.id } })) !== 30
      )
        throw new Error('LOAD_API_CREATION_EVIDENCE_MISSING');
      actors.push(Object.freeze({ userId, generalId: row.id, worldId, client }));
    }
    const historicalRows = await db.general.count({
      where: { worldId, id: { in: profile.historicalGeneralIds }, userId: null },
    });
    if (
      historicalRows !== LOAD_CONTRACT.historicalGenerals ||
      (await db.general.count({ where: { worldId } })) < LOAD_CONTRACT.generalsPerWorld
    )
      throw new Error('LOAD_WORLD_POPULATION_MISMATCH');
    worlds.push({
      worldId,
      turnTermMinutes: plan.turnTermMinutes,
      profile,
      actors,
      users: actors.slice(0, LOAD_CONTRACT.usersPerWorld),
    });
  }
  const fixtureAccounts = await db.user.count();
  const realApiHumans = worlds.reduce((count, world) => count + world.actors.length, 0);
  if (
    fixtureAccounts !== LOAD_CONTRACT.accounts ||
    realApiHumans !== LOAD_CONTRACT.accounts ||
    new Set(worlds.map((world) => world.worldId)).size !== 2
  )
    throw new Error('LOAD_FIXTURE_CARDINALITY_MISMATCH');
  return { resourceManifest, worlds, fixtureAccounts, realApiHumans };
}
