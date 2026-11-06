// T2-15 AC-M2-08. 명시적으로 dispatch한 후보의 app-runtime 자원만 검사한다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { hashState } from '../../packages/shared/src/node/hashState.ts';
import { BOOTSTRAP_DOCKER, requireDispatch } from '../load/bootstrap.mjs';
import { fileInventory, prepareCandidateSource } from '../release-artifact.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const owner = randomUUID();
const image = `opensamguk-resource-check:${owner}`;
const container = `opensamguk-resource-check-${owner}`;
const ownerLabel = 'org.opensamguk.test.owner';
const files = [
  'feature-profile/expanded-191-v2.json',
  'feature-profile/expanded-191-v1.json',
  'feature-profile/expanded-191-v3.json',
  'feature-profile/expanded-191-v4.json',
  'feature-profile/expanded-191-v5.json',
  'scenario/san10-191-v2.json',
  ...['191-sex.json', '191-sex-2.json', '191-sex-3.json'].map((file) => `officers/${file}`),
];
const output = process.env.RUNTIME_RESOURCES_OUTPUT;
let reserved = false,
  phase = 'source',
  source,
  imageId,
  containerId,
  observed,
  attemptedContainer = false;
let resourceChecksPassed = false,
  failure = null;
const cleanup = { container: 'not-attempted', image: 'not-attempted' };

function command(executable, args, log, timeout = 30_000, allowFailure = false) {
  if (executable === 'docker') args = ['--host', BOOTSTRAP_DOCKER.endpoint, ...args];
  const descriptor = log ? fs.openSync(path.join(output, log), 'wx') : undefined;
  let result;
  try {
    result = spawnSync(executable, args, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      ...(descriptor === undefined ? {} : { stdio: ['ignore', descriptor, descriptor] }),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`${executable} failed during ${phase}; exit=${result.status}`);
  }
  return result.stdout ?? '';
}
const inspect = (kind, id) => {
  const text = command('docker', [kind, 'inspect', id], undefined, 15_000, true);
  return text === null ? null : JSON.parse(text)[0];
};
const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

try {
  assert.equal(process.platform, 'linux');
  const head = command('git', ['rev-parse', 'HEAD']).trim();
  requireDispatch({
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    expectedSha: process.env.RUNTIME_RESOURCES_EXPECTED_SHA,
    dispatchSha: process.env.GITHUB_SHA,
    head,
  });
  assert.equal(process.env.LOAD_EXPECTED_SHA ?? '', '');
  assert.equal(command('git', ['status', '--porcelain']).trim(), '');
  assert.ok(output && process.env.RUNNER_TEMP);
  assert.equal(path.dirname(path.resolve(output)), path.resolve(process.env.RUNNER_TEMP));
  assert.match(path.basename(output), /^expanded-resources-\d+-\d+$/);
  assert.ok(!/[,"\r\n]/.test(output));
  fs.mkdirSync(output);
  reserved = true;
  const context = path.join(output, 'context');
  source = { revision: head, ...(await prepareCandidateSource(root, head, context)) };
  const inventory = await fileInventory(context);
  fs.writeFileSync(path.join(output, 'source.json'), JSON.stringify({ ...source, inventory }, null, 2), { flag: 'wx' });

  // 의존성 링크는 동결 context 밖에 둔다. 모든 자체 코드 입력은 context를 가리켜야 한다.
  const dependencies = path.join(output, 'dependencies');
  fs.mkdirSync(path.join(dependencies, '@opensamguk'), { recursive: true });
  for (const directory of fs.readdirSync(path.join(context, 'packages'), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const folder = path.join(context, 'packages', directory.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8'));
    assert.match(manifest.name, /^@opensamguk\/[a-z0-9-]+$/);
    fs.symlinkSync(folder, path.join(dependencies, manifest.name), 'dir');
  }
  const probe = path.join(output, 'resource-loader.mjs');
  const bundle = await build({
    stdin: {
      contents: `export { loadSexLedger, loadSexLedgers, loadFeatureProfile } from ${JSON.stringify(path.join(context, 'apps/engine/src/world/resources.ts'))};`,
      resolveDir: context,
      loader: 'ts',
    },
    external: ['@opensamguk/db'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: probe,
    metafile: true,
    nodePaths: [dependencies, path.join(root, 'node_modules')],
  });
  for (const input of Object.keys(bundle.metafile.inputs)) {
    if (input === '<stdin>') continue;
    const resolved = fs.realpathSync(path.resolve(root, input));
    assert.ok(
      resolved.startsWith(context + path.sep) || resolved.startsWith(path.join(root, 'node_modules') + path.sep),
    );
  }
  for (const emitted of Object.values(bundle.metafile.outputs))
    assert.ok(emitted.imports.every((dependency) => isBuiltin(dependency.path)));
  fs.chmodSync(probe, 0o644);
  const expectedFiles = Object.fromEntries(
    files.map((file) => [file, bytesHash(fs.readFileSync(path.join(context, 'resources', file)))]),
  );
  const ledgers = files
    .filter((file) => file.startsWith('officers/'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(context, 'resources', file), 'utf8')));
  const profile = JSON.parse(fs.readFileSync(path.join(context, 'resources', files[0]), 'utf8'));
  const expanded = JSON.parse(
    fs.readFileSync(path.join(context, 'resources/feature-profile/expanded-191-v4.json'), 'utf8'),
  );
  const lifecycle = JSON.parse(
    fs.readFileSync(path.join(context, 'resources/feature-profile/expanded-191-v5.json'), 'utf8'),
  );

  phase = 'build';
  cleanup.image = 'unverified';
  command(
    'docker',
    [
      'build',
      '--progress=plain',
      '--file',
      path.join(context, 'deploy/Dockerfile'),
      '--target',
      'app-runtime',
      '--build-arg',
      `SOURCE_REVISION=${head}`,
      '--build-arg',
      `SOURCE_TREE_SHA256=${source.sourceTreeSha256}`,
      '--label',
      `${ownerLabel}=${owner}`,
      '--tag',
      image,
      context,
    ],
    'build.log',
    600_000,
  );
  const built = inspect('image', image);
  assert.ok(built);
  imageId = built.Id;
  assert.equal(built.Config.Labels[ownerLabel], owner);
  assert.equal(built.Config.Labels['org.opencontainers.image.revision'], head);
  assert.equal(built.Config.Labels['org.opensamguk.source-tree-sha256'], source.sourceTreeSha256);
  assert.equal(built.Config.User, '10001:10001');
  assert.ok(built.Config.Env.includes('NODE_ENV=production'));
  assert.ok(built.Config.Env.includes('OPENSAMGUK_RESOURCES_ROOT=/app/resources'));

  phase = 'run';
  const code = `import fs from 'node:fs'; import {createHash} from 'node:crypto';
    import {loadSexLedger,loadSexLedgers,loadFeatureProfile} from '/probe.mjs';
    const all=loadSexLedgers(), p=await loadFeatureProfile('expanded-191-v2'), legacy=await loadFeatureProfile('expanded-191-v1'), expanded=await loadFeatureProfile('expanded-191-v4'), lifecycle=await loadFeatureProfile('expanded-191-v5');
    console.log(JSON.stringify({node:process.version,uid:process.getuid(),gid:process.getgid(),root:process.env.OPENSAMGUK_RESOURCES_ROOT,
      files:Object.fromEntries(${JSON.stringify(files)}.map(f=>[f,createHash('sha256').update(fs.readFileSync('/app/resources/'+f)).digest('hex')])),
      rows:all.map(x=>x.rows.length),hashes:all.map(x=>x.review.contentSha256),latest:loadSexLedger().review.contentSha256,
      profile:{key:p.value.key,hash:p.contentHash,features:p.value.ruleFeatures,dataKeys:Object.keys(p.value.featureData).sort(),
        birthBp:p.value.featureData['lineage-v1'].birth.chanceBp,maxGenerals:p.value.featureData['lineage-v1'].limits.maxGenerals,
        lineageVersion:p.value.featureData['lineage-v1'].version,equipmentItems:p.value.featureData['equipment-v1'].items.length},
      legacyProfile:{key:legacy.value.key,hash:legacy.contentHash},
      lifecycleProfile:{key:lifecycle.value.key,hash:lifecycle.contentHash,features:lifecycle.value.ruleFeatures,
        dataKeys:Object.keys(lifecycle.value.featureData).sort(),selection:Object.fromEntries(
          ['mapKey','scenarioKey','unitSetKey','statRulesKey','portraitMapKey'].map(key=>[key,lifecycle.value[key]]))},
      expandedProfile:{key:expanded.value.key,hash:expanded.contentHash,features:expanded.value.ruleFeatures,
        dataKeys:Object.keys(expanded.value.featureData).sort(),selection:Object.fromEntries(
          ['mapKey','scenarioKey','unitSetKey','statRulesKey','portraitMapKey'].map(key=>[key,expanded.value[key]]))}}));`;
  attemptedContainer = true;
  cleanup.container = 'unverified';
  containerId = command('docker', [
    'create',
    '--name',
    container,
    '--label',
    `${ownerLabel}=${owner}`,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--entrypoint',
    'node',
    '--mount',
    `type=bind,src=${probe},dst=/probe.mjs,readonly`,
    imageId,
    '--input-type=module',
    '--eval',
    code,
  ]).trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  command('docker', ['start', '--attach', containerId], 'probe.log', 60_000);
  const stopped = inspect('container', containerId);
  assert.ok(stopped);
  assert.equal(stopped.Config.Labels[ownerLabel], owner);
  assert.equal(stopped.Image, imageId);
  assert.equal(stopped.State.Status, 'exited');
  assert.equal(stopped.State.ExitCode, 0);
  assert.equal(stopped.HostConfig.ReadonlyRootfs, true);
  assert.equal(stopped.HostConfig.NetworkMode, 'none');
  assert.equal(stopped.HostConfig.Privileged, false);
  assert.equal(stopped.Mounts.find((mount) => mount.Destination === '/probe.mjs')?.RW, false);
  observed = JSON.parse(fs.readFileSync(path.join(output, 'probe.log'), 'utf8').trim());
  assert.match(observed.node, /^v24\./);
  assert.equal(observed.uid, 10001);
  assert.equal(observed.gid, 10001);
  assert.equal(observed.root, '/app/resources');
  assert.deepEqual(observed.files, expectedFiles);
  assert.deepEqual(
    observed.rows,
    ledgers.map((value) => value.rows.length),
  );
  assert.deepEqual(
    observed.hashes,
    ledgers.map((value) => value.review.contentSha256),
  );
  assert.equal(observed.latest, ledgers.at(-1).review.contentSha256);
  assert.equal(observed.profile.key, profile.key);
  assert.equal(observed.profile.hash, hashState(profile));
  assert.deepEqual(observed.profile.features, profile.ruleFeatures);
  assert.equal(observed.profile.features.length, 14);
  assert.deepEqual(observed.profile.dataKeys, Object.keys(profile.featureData).sort());
  assert.equal(observed.profile.birthBp, 500);
  assert.equal(observed.profile.maxGenerals, 2500);
  assert.equal(observed.profile.lineageVersion, 2);
  assert.equal(observed.profile.equipmentItems, 18);
  assert.deepEqual(observed.expandedProfile, {
    key: expanded.key,
    hash: hashState(expanded),
    features: expanded.ruleFeatures,
    dataKeys: Object.keys(expanded.featureData).sort(),
    selection: Object.fromEntries(
      ['mapKey', 'scenarioKey', 'unitSetKey', 'statRulesKey', 'portraitMapKey'].map((key) => [key, expanded[key]]),
    ),
  });
  assert.equal(observed.expandedProfile.features.length, 19);
  assert.deepEqual(observed.lifecycleProfile, {
    key: lifecycle.key,
    hash: hashState(lifecycle),
    features: lifecycle.ruleFeatures,
    dataKeys: Object.keys(lifecycle.featureData).sort(),
    selection: Object.fromEntries(
      ['mapKey', 'scenarioKey', 'unitSetKey', 'statRulesKey', 'portraitMapKey'].map((key) => [key, lifecycle[key]]),
    ),
  });
  assert.equal(observed.lifecycleProfile.features.length, 20);
  assert.equal(observed.legacyProfile.key, 'expanded-191-v1');
  assert.equal(
    observed.legacyProfile.hash,
    hashState(
      JSON.parse(fs.readFileSync(path.join(context, 'resources/feature-profile/expanded-191-v1.json'), 'utf8')),
    ),
  );
  assert.deepEqual(await fileInventory(context), inventory);
  assert.equal(command('git', ['rev-parse', 'HEAD']).trim(), head);
  assert.equal(command('git', ['status', '--porcelain']).trim(), '');
  resourceChecksPassed = true;
  phase = 'complete';
} catch (error) {
  failure = error instanceof Error ? error.message : 'Resource verification failed';
} finally {
  try {
    if (attemptedContainer) {
      const value = inspect('container', containerId || container);
      assert.ok(value, 'Test container state is unverified');
      containerId = value.Id;
      assert.equal(value.Config.Labels[ownerLabel], owner);
      if (value.State.Running) {
        cleanup.container = 'preserved-running';
        cleanup.image = 'preserved-in-use';
        cleanup.error = 'Running test container preserved';
      } else {
        command('docker', ['container', 'rm', containerId]);
        cleanup.container = 'removed';
      }
    }
    if (imageId && !cleanup.error) {
      const value = inspect('image', imageId);
      assert.ok(value);
      assert.equal(value.Config.Labels[ownerLabel], owner);
      command('docker', ['image', 'rm', imageId]);
      cleanup.image = 'removed';
    }
  } catch (error) {
    cleanup.error = error instanceof Error ? error.message : 'Cleanup unverified';
  }
  const success = resourceChecksPassed && !cleanup.error;
  if (reserved)
    fs.writeFileSync(
      path.join(output, 'receipt.json'),
      JSON.stringify(
        {
          kind: 'candidate-app-runtime-resource-check',
          release: false,
          source,
          owner,
          phase,
          resourceChecksPassed,
          success,
          imageId: imageId ?? null,
          containerId: containerId ?? null,
          observed,
          cleanup,
          failure,
          finishedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: 'wx' },
    );
  console.log(JSON.stringify({ phase, success, resourceChecksPassed, cleanup, failure }));
  if (!success) process.exitCode = 1;
}
