import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fileInventory, finalizeManifest, hashFile } from './release-artifact.ts';
import { preflightRelease } from './release-preflight.ts';
import {
  officialImages,
  preflightTarget,
  runTargetNative,
  TargetPreflightError,
  volumePurposes,
  type TargetInput,
} from './release-target-preflight.ts';

// Controlled metadata artifacts only. These are never a game/server/release acceptance fixture.
export async function createTargetFixture(
  root: string,
  makeImages?: (tree: string, archive: string) => Promise<string[]>,
) {
  const revision = 'a'.repeat(40),
    release = join(root, 'artifact'),
    partial = join(release, '.partial-' + randomUUID());
  const context = join(partial, 'context'),
    web = join(release, 'payload/web');
  await mkdir(web, { recursive: true });
  const migration = '20260101000000_fixture';
  for (const [name, content] of Object.entries({
    ['packages/db/prisma/migrations/' + migration + '/migration.sql']: '-- metadata fixture, no database\n',
    'packages/db/sql/resources-init.sql': '-- metadata fixture\n',
    'manifest/public-assets.json': JSON.stringify({
      portraitPolicy: 'fallback-only',
      remoteImageBases: [],
      externalAssetOrigins: [],
    }),
    'deploy/compose.yml': await readFile(fileURLToPath(new URL('../deploy/compose.yml', import.meta.url)), 'utf8'),
    'deploy/Caddyfile': await readFile(fileURLToPath(new URL('../deploy/Caddyfile', import.meta.url)), 'utf8'),
    'deploy/security.caddy': await readFile(
      fileURLToPath(new URL('../deploy/security.caddy', import.meta.url)),
      'utf8',
    ),
  })) {
    await mkdir(dirname(join(context, name)), { recursive: true });
    await writeFile(join(context, name), content);
  }
  await writeFile(join(partial, 'source.tar'), 'controlled metadata source archive\n');
  await writeFile(join(release, 'payload/web.tar'), 'controlled metadata web archive\n');
  await writeFile(join(web, 'index.html'), '<html>metadata fixture</html>');
  await writeFile(
    join(web, 'public-build.json'),
    JSON.stringify({ mode: 'public', imageBaseUrl: '', images: Array.from({ length: 6 }, (_, id) => ({ id })) }),
  );
  const hash = createHash('sha256');
  for (const file of await fileInventory(context))
    hash
      .update(file.path + '\0')
      .update(await readFile(join(context, file.path)))
      .update('\0');
  const tree = hash.digest('hex'),
    archive = join(release, 'payload/images.tar');
  const ids = makeImages ? await makeImages(tree, archive) : ['1', '2', '3'].map((v) => 'sha256:' + v.repeat(64));
  if (!makeImages) await writeFile(archive, 'controlled metadata image archive\n');
  const manifest = {
    version: 1,
    sourceRevision: revision,
    sourceTreeSha256: tree,
    sourceArchive: await hashFile(join(partial, 'source.tar')),
    packageManager: 'pnpm@10.33.0',
    images: ['server', 'engine', 'migrate'].map((target, i) => ({
      target,
      id: ids[i],
      revision,
      sourceTreeSha256: tree,
    })),
    imageArchive: { path: 'payload/images.tar', ...(await hashFile(archive)) },
    web: {
      directory: 'payload/web',
      files: await fileInventory(web),
      archive: { path: 'payload/web.tar', ...(await hashFile(join(release, 'payload/web.tar'))) },
      imageBaseUrl: '',
    },
    migrations: [
      {
        name: migration,
        ...(await hashFile(join(context, 'packages/db/prisma/migrations', migration, 'migration.sql'))),
      },
    ],
    resourcesSql: await hashFile(join(context, 'packages/db/sql/resources-init.sql')),
    publicAssets: {
      ...(await hashFile(join(context, 'manifest/public-assets.json'))),
      portraitPolicy: 'fallback-only',
      externalPortraits: 0,
    },
    dataContract: 'unknown',
  };
  const manifestPath = await finalizeManifest(release, manifest),
    manifestSha256 = (await hashFile(manifestPath)).sha256;
  const prior = await preflightRelease({
    manifestPath,
    manifestSha256,
    sourceRevision: revision,
    receiptDirectory: join(root, 'prior'),
  });
  const prefix = 't215_' + randomUUID().replaceAll('-', '');
  const volumes = {
    appSecrets: prefix + '_app',
    pgSecrets: prefix + '_pg',
    pgData: prefix + '_data',
    caddyData: prefix + '_caddy',
  };
  const environment = {
    SERVER_IMAGE: ids[0]!,
    ENGINE_IMAGE: ids[1]!,
    MIGRATE_IMAGE: ids[2]!,
    PUBLIC_HOST: 'metadata.invalid',
    PUBLIC_ORIGIN: 'https://metadata.invalid',
    BIND_ADDRESS: '127.0.0.1',
    HTTP_PORT: '18080',
    HTTPS_PORT: '18443',
    MAIL_FROM: 'fixture@metadata.invalid',
    POSTGRES_USER: 'fixture',
    POSTGRES_DB: 'fixture',
    PUBLIC_WEB_DIRECTORY: web.split('\\').join('/'),
    APP_SECRETS_VOLUME: volumes.appSecrets,
    PG_SECRETS_VOLUME: volumes.pgSecrets,
    PG_DATA_VOLUME: volumes.pgData,
    CADDY_DATA_VOLUME: volumes.caddyData,
  };
  const environmentFile = join(root, 'nonsecret.env');
  await writeFile(
    environmentFile,
    Object.entries(environment)
      .map(([k, v]) => k + '=' + v)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  const config = join(root, 'docker-empty');
  await mkdir(config, { mode: 0o700 });
  const composeFile = join(context, 'deploy/compose.yml');
  const input: TargetInput = {
    version: 1,
    artifact: {
      manifestPath,
      manifestSha256,
      sourceRevision: revision,
      preflightReceiptPath: prior.receiptPath,
      preflightReceiptSha256: prior.receiptSha256,
    },
    target: {
      dockerExecutable: '/usr/bin/docker',
      dockerHost: 'unix:///var/run/docker.sock',
      dockerConfigDirectory: config,
      expectedDaemonId: 'fixture-daemon',
      ownerId: prefix,
      targetId: prefix,
      composeFile,
      composeSha256: (await hashFile(composeFile)).sha256,
      environmentFile,
      environmentSha256: (await hashFile(environmentFile)).sha256,
      projectName: prefix.replaceAll('_', '-'),
      volumes,
    },
    receiptDirectory: join(root, 'target'),
  };
  return { input, manifest, environment, root, release, context, tree };
}

// Actual Linux Node probes only. They never start Docker, an application or a database.
export async function verifyTargetNativeDescendants(root: string, signal: AbortSignal) {
  if (process.platform !== 'linux') throw new Error('LINUX_NATIVE_PROBE_REQUIRED');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
      throw new Error('NATIVE_PROBE_IDENTITY', { cause: error });
    }
  };
  const identity = async (pid: number, marker: string) => {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (fields.length < 20 || !command.split('\0').includes(marker)) throw new Error('NATIVE_PROBE_IDENTITY');
    return { pid, start: fields[19]!, group: Number(fields[2]), executable: await realpath(`/proc/${pid}/exe`) };
  };
  const until = async (check: () => Promise<boolean>, deadline: number) => {
    for (;;) {
      signal.throwIfAborted();
      if (await check()) return;
      if (Date.now() >= deadline) throw new Error('NATIVE_PROBE_DEADLINE');
      await delay(25, undefined, { signal });
    }
  };
  for (const escaped of [false, true]) {
    const marker = 't215-native-' + randomUUID(),
      file = join(root, escaped ? 'native-escaped.json' : 'native-group.json');
    const local = new AbortController(),
      ownSignal = AbortSignal.any([signal, local.signal]);
    const code = [
      "const {spawn}=require('node:child_process'),fs=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[3]],{detached:process.argv[2]==='1',stdio:['ignore',1,2]});",
      'fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,grandchild:child.pid,marker:process.argv[3]}),{mode:0o600});',
      'setInterval(()=>{},1000);',
    ].join('');
    const execution = runTargetNative(
      process.execPath,
      ['-e', code, file, escaped ? '1' : '0', marker],
      ownSignal,
    ).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error: error as unknown }),
    );
    let rows: { parent: number; grandchild: number; marker: string } | undefined;
    let grandchild: Awaited<ReturnType<typeof identity>> | undefined;
    const errors: unknown[] = [];
    try {
      await until(async () => {
        try {
          rows = JSON.parse(await readFile(file, 'utf8')) as typeof rows;
          return true;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
          throw new Error('NATIVE_PROBE_INPUT', { cause: error });
        }
      }, Date.now() + 5000);
      if (
        !rows ||
        rows.marker !== marker ||
        !Number.isSafeInteger(rows.parent) ||
        !Number.isSafeInteger(rows.grandchild) ||
        rows.parent <= 1 ||
        rows.grandchild <= 1 ||
        rows.parent === rows.grandchild ||
        rows.parent === process.pid ||
        rows.grandchild === process.pid
      )
        throw new Error('NATIVE_PROBE_IDENTITY');
      const parent = await identity(rows.parent, marker);
      grandchild = await identity(rows.grandchild, marker);
      if (
        parent.group !== parent.pid ||
        grandchild.group !== (escaped ? grandchild.pid : parent.pid) ||
        !alive(parent.pid) ||
        !alive(grandchild.pid)
      )
        throw new Error('NATIVE_PROBE_IDENTITY');
      local.abort();
      const result = await execution;
      if (!(result.error instanceof TargetPreflightError)) throw new Error('NATIVE_PROBE_FALSE_SUCCESS');
      if (!escaped) {
        if (result.error.code !== 'NATIVE' || result.error.stickyUnsettled)
          throw new Error('NATIVE_PROBE_GROUP_UNSETTLED');
        await until(async () => !alive(parent.pid) && !alive(grandchild!.pid), Date.now() + 5000);
      } else {
        const facts = result.error.nativeSettlement;
        if (
          result.error.code !== 'NATIVE_UNSETTLED' ||
          !result.error.stickyUnsettled ||
          !facts?.handlesReleased ||
          facts.actualClose ||
          facts.stdoutEnded ||
          facts.stderrEnded ||
          !facts.groupAbsent
        )
          throw new Error('NATIVE_PROBE_FALSE_SETTLEMENT');
        if (
          !alive(grandchild.pid) ||
          JSON.stringify(await identity(grandchild.pid, marker)) !== JSON.stringify(grandchild)
        )
          throw new Error('NATIVE_PROBE_IDENTITY');
      }
    } catch (error) {
      errors.push(error);
    } finally {
      local.abort();
      await execution; // This always settles under the original10s+60s native contract.
      if (escaped && grandchild)
        try {
          if (alive(grandchild.pid)) {
            const fresh = await identity(grandchild.pid, marker);
            if (JSON.stringify(fresh) !== JSON.stringify(grandchild) || fresh.group !== fresh.pid)
              errors.push(new Error('NATIVE_PROBE_CLEANUP_IDENTITY'));
            else process.kill(-fresh.group, 'SIGKILL');
          }
          await until(async () => !alive(grandchild!.pid), Date.now() + 5000);
        } catch (error) {
          errors.push(error);
        }
    }
    if (errors.length) throw new AggregateError(errors, 'NATIVE_PROBE_FAILED');
  }
  return { cases: 2, sameGroupClosed: true, escapedStickyFailure: true, localHandlesReleased: true };
}

// Only literal codes used by the target consumer are public; no message/cause/native output is copied.
const metadataTargetFailureCodes = new Set([
  'ARCHITECTURE',
  'COMPOSE',
  'COMPOSE_PATH',
  'COMPOSE_TEMPLATE',
  'CONFIG',
  'DAEMON',
  'ENV',
  'ENV_IMAGE',
  'ENV_VOLUME',
  'ENV_WEB',
  'EXECUTABLE',
  'FILE',
  'HASH',
  'IMAGE',
  'INPUT_OR_IO',
  'MODE',
  'MODEL',
  'NATIVE',
  'NATIVE_UNSETTLED',
  'OUTPUT',
  'PATH',
  'PLATFORM',
  'RECEIPT',
  'REPLACED',
  'SOCKET',
  'VOLUME',
]);
export function metadataLinuxFailureCode(error: unknown) {
  if (error instanceof TargetPreflightError) {
    const code = error.code;
    if (metadataTargetFailureCodes.has(code)) return code;
  }
  return 'FIXTURE_STEP_FAILED';
}

async function realLinuxMetadata() {
  if (process.platform !== 'linux' || !process.env.GITHUB_ACTIONS || process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('LINUX_CI_REQUIRED');
  const root = await mkdtemp(join(tmpdir(), 'opensamguk-target-')),
    controller = new AbortController();
  const docker = await realpath('/usr/bin/docker');
  const config = join(root, 'setup-empty');
  await mkdir(config, { mode: 0o700 });
  const overall = setTimeout(() => controller.abort(), 8 * 60000);
  const command = (args: string[]) =>
    runTargetNative(docker, ['--host', 'unix:///var/run/docker.sock', '--config', config, ...args], controller.signal);
  const baselineImages = new Set<string>(),
    baselineVolumes = new Set<string>();
  const ownImages: string[] = [],
    ownVolumes: Array<{ name: string; createdAt: string; labels: Record<string, string> }> = [];
  let failed = false,
    assertions = 0,
    nativeProbeVerified = false;
  let stage = 'native-probes';
  let failureCode: string | undefined;
  const failures: unknown[] = [];
  const assert = (v: unknown) => {
    if (!v) throw new Error('METADATA_ASSERTION');
    assertions++;
  };
  try {
    const nativeProof = await verifyTargetNativeDescendants(root, controller.signal);
    assert(
      nativeProof.cases === 2 &&
        nativeProof.sameGroupClosed &&
        nativeProof.escapedStickyFailure &&
        nativeProof.localHandlesReleased,
    );
    nativeProbeVerified = true;
    stage = 'baseline-images';
    for (const id of (await command(['image', 'ls', '--no-trunc', '--quiet'])).trim().split('\n').filter(Boolean))
      baselineImages.add(id);
    stage = 'baseline-volumes';
    for (const name of (await command(['volume', 'ls', '--quiet'])).trim().split('\n').filter(Boolean))
      baselineVolumes.add(name);
    for (const reference of Object.values(officialImages)) {
      // Fixture setup may acquire these two fixed official metadata references; checker never pulls.
      stage = reference === officialImages.postgres ? 'official-postgres-pull' : 'official-caddy-pull';
      await command(['pull', reference]);
      stage = 'official-image-inspect';
      const id = (await command(['image', 'inspect', reference, '--format', '{{.Id}}'])).trim();
      if (!baselineImages.has(id) && !ownImages.includes(id)) ownImages.push(id);
    }
    stage = 'fixture-artifact';
    const f = await createTargetFixture(join(root, 'fixture'), async (tree, archive) => {
      const tar = join(root, 'empty.tar');
      await writeFile(tar, Buffer.alloc(10240));
      const ids: string[] = [];
      for (const target of ['server', 'engine', 'migrate']) {
        const id = (
          await command([
            'image',
            'import',
            '--change',
            'USER 10001:10001',
            '--change',
            'ENV NODE_ENV=production',
            '--change',
            'LABEL org.opencontainers.image.revision=' + 'a'.repeat(40),
            '--change',
            'LABEL org.opensamguk.source-tree-sha256=' + tree,
            '--change',
            'LABEL org.opensamguk.metadata-fixture=' + target,
            tar,
          ])
        ).trim();
        if (!/^sha256:[a-f0-9]{64}$/.test(id) || baselineImages.has(id)) throw new Error('OWN_IMAGE_ID');
        ownImages.push(id);
        ids.push(id);
      }
      await command(['image', 'save', '--output', archive, ...ids]);
      return ids;
    });
    stage = 'fixture-volumes';
    f.input.target.dockerExecutable = docker;
    f.input.target.expectedDaemonId = (await command(['info', '--format', '{{.ID}}'])).trim();
    const addVolume = async (name: string, purpose: string, wrong = false) => {
      if (baselineVolumes.has(name)) throw new Error('OWN_VOLUME_NAME');
      const labels = {
        'org.opensamguk.owner': wrong ? 'wrong-owner' : f.input.target.ownerId,
        'org.opensamguk.target': f.input.target.targetId,
        'org.opensamguk.purpose': purpose,
      };
      await command([
        'volume',
        'create',
        ...Object.entries(labels).flatMap(([k, v]) => ['--label', k + '=' + v]),
        name,
      ]);
      const v = JSON.parse(await command(['volume', 'inspect', name, '--format', '{{json .}}'])) as {
        CreatedAt: string;
        Labels: Record<string, string>;
      };
      ownVolumes.push({ name, createdAt: v.CreatedAt, labels });
    };
    for (const [key, purpose] of Object.entries(volumePurposes))
      await addVolume(f.input.target.volumes[key as keyof typeof volumePurposes], purpose);
    stage = 'metadata-checks';
    const result = await preflightTarget(f.input, controller.signal);
    controller.signal.throwIfAborted();
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as Record<string, unknown>;
    assert(
      receipt.outcome === 'target-metadata-preflight-passed' &&
        receipt.operationalReady === false &&
        receipt.secretUidModeVerified === false &&
        receipt.dbQueried === false,
    );
    const reject = async (input: TargetInput, expectedCode: string) => {
      let rejected = false;
      try {
        await preflightTarget(input, controller.signal);
      } catch (error) {
        rejected =
          error instanceof TargetPreflightError && error.code === expectedCode && !error.message.includes('canary');
      }
      assert(rejected);
      controller.signal.throwIfAborted();
    };
    await reject(
      {
        ...f.input,
        receiptDirectory: join(root, 'wrong-daemon'),
        target: { ...f.input.target, expectedDaemonId: 'not-the-recorded-daemon' },
      },
      'DAEMON',
    );
    // A real imported image with the manifest ID but a wrong revision label must fail.
    const badImage = (
      await command([
        'image',
        'import',
        '--change',
        'USER 10001:10001',
        '--change',
        'ENV NODE_ENV=production',
        '--change',
        'LABEL org.opencontainers.image.revision=' + 'b'.repeat(40),
        '--change',
        'LABEL org.opensamguk.source-tree-sha256=' + f.tree,
        join(root, 'empty.tar'),
      ])
    ).trim();
    assert(/^sha256:[a-f0-9]{64}$/.test(badImage) && !baselineImages.has(badImage));
    ownImages.push(badImage);
    const bad = await createTargetFixture(join(root, 'bad-image-fixture'), async (tree, archive) => {
      assert(tree === f.tree);
      const ids = [badImage, f.manifest.images[1]!.id!, f.manifest.images[2]!.id!];
      await command(['image', 'save', '--output', archive, ...ids]);
      return ids;
    });
    bad.input.target = {
      ...bad.input.target,
      dockerExecutable: docker,
      expectedDaemonId: f.input.target.expectedDaemonId,
      ownerId: f.input.target.ownerId,
      targetId: f.input.target.targetId,
      volumes: f.input.target.volumes,
    };
    const badEnvironment = {
      ...bad.environment,
      APP_SECRETS_VOLUME: f.environment.APP_SECRETS_VOLUME,
      PG_SECRETS_VOLUME: f.environment.PG_SECRETS_VOLUME,
      PG_DATA_VOLUME: f.environment.PG_DATA_VOLUME,
      CADDY_DATA_VOLUME: f.environment.CADDY_DATA_VOLUME,
    };
    await writeFile(
      bad.input.target.environmentFile,
      Object.entries(badEnvironment)
        .map(([key, value]) => key + '=' + value)
        .join('\n') + '\n',
    );
    bad.input.target.environmentSha256 = (await hashFile(bad.input.target.environmentFile)).sha256;
    await reject(bad.input, 'IMAGE');
    const wrongName = f.input.target.volumes.appSecrets + '_wrong';
    await addVolume(wrongName, 'app-secrets', true);
    const wrongEnv = join(root, 'wrong.env');
    await writeFile(
      wrongEnv,
      Object.entries({ ...f.environment, APP_SECRETS_VOLUME: wrongName })
        .map(([k, v]) => k + '=' + v)
        .join('\n') + '\n',
    );
    await reject(
      {
        ...f.input,
        receiptDirectory: join(root, 'wrong-owner'),
        target: {
          ...f.input.target,
          environmentFile: wrongEnv,
          environmentSha256: (await hashFile(wrongEnv)).sha256,
          volumes: { ...f.input.target.volumes, appSecrets: wrongName },
        },
      },
      'VOLUME',
    );
    await reject(f.input, 'INPUT_OR_IO'); // Existing output is never adopted or overwritten.
    const secretEnv = join(root, 'secret.env');
    await writeFile(
      secretEnv,
      (await readFile(f.input.target.environmentFile, 'utf8')) + 'DATABASE_URL=canary-not-a-url\n',
    );
    await reject(
      {
        ...f.input,
        receiptDirectory: join(root, 'secret'),
        target: {
          ...f.input.target,
          environmentFile: secretEnv,
          environmentSha256: (await hashFile(secretEnv)).sha256,
        },
      },
      'ENV',
    );
    assert((await hashFile(result.receiptPath)).sha256 === result.receiptSha256);
    assert((await hashFile(f.input.artifact.manifestPath)).sha256 === f.input.artifact.manifestSha256);
  } catch (error) {
    failed = true;
    failureCode = metadataLinuxFailureCode(error);
    failures.push(error);
  } finally {
    // Failures preserve fixture resources. Success deletes only re-inspected exact owned identities.
    if (!failed && !controller.signal.aborted) {
      for (const owned of ownVolumes)
        try {
          const actual = JSON.parse(await command(['volume', 'inspect', owned.name, '--format', '{{json .}}'])) as {
            Name: string;
            CreatedAt: string;
            Labels: Record<string, string>;
          };
          assert(
            !(
              actual.Name !== owned.name ||
              actual.CreatedAt !== owned.createdAt ||
              Object.keys(actual.Labels).length !== 3 ||
              Object.entries(owned.labels).some(([key, value]) => actual.Labels[key] !== value)
            ),
          );
          await command(['volume', 'rm', owned.name]);
        } catch (error) {
          failures.push(error);
        }
      for (const id of ownImages.reverse())
        try {
          assert(
            (await command(['image', 'inspect', id, '--format', '{{.Id}}'])).trim() === id && !baselineImages.has(id),
          );
          await command(['image', 'rm', id]);
        } catch (error) {
          failures.push(error);
        }
      try {
        const afterImages = [
          ...new Set((await command(['image', 'ls', '--no-trunc', '--quiet'])).trim().split('\n').filter(Boolean)),
        ];
        const afterVolumes = (await command(['volume', 'ls', '--quiet'])).trim().split('\n').filter(Boolean);
        assert(afterImages.length === baselineImages.size && afterImages.every((id) => baselineImages.has(id)));
        assert(afterVolumes.length === baselineVolumes.size && afterVolumes.every((name) => baselineVolumes.has(name)));
      } catch (error) {
        failures.push(error);
      }
    }
    clearTimeout(overall);
    if (controller.signal.aborted) failures.push(new Error('FIXTURE_DEADLINE'));
    const safe = {
      version: 1,
      outcome: failures.length === 0 ? 'metadata-linux-fixture-passed' : 'metadata-linux-fixture-failed',
      assertions,
      nativeProbeCases: nativeProbeVerified ? 2 : 0,
      nativeProbeVerified,
      failureStage: failed ? stage : undefined,
      failureCode,
      failures: failures.length,
      dbQueried: false,
      secretsRead: false,
      operationalReady: false,
      fixtureResourcesPreserved: failed || failures.length > 0,
    };
    await writeFile(join(root, 'summary.json'), JSON.stringify(safe) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(safe));
  }
  if (failures.length) throw new Error('METADATA_LINUX_FIXTURE_FAILED');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await realLinuxMetadata();
  } catch {
    console.error('METADATA_LINUX_FIXTURE_FAILED');
    process.exitCode = 1;
  }
}
