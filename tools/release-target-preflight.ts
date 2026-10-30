import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { hashFile } from './release-artifact';
import { preflightRelease } from './release-preflight';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const imageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const absolute = z
  .string()
  .min(1)
  .refine(isAbsolute)
  .refine((v) => !/[\0\r\n]/.test(v));
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/);
export const targetInput = z.strictObject({
  version: z.literal(1),
  artifact: z.strictObject({
    manifestPath: absolute,
    manifestSha256: digest,
    sourceRevision: revision,
    preflightReceiptPath: absolute,
    preflightReceiptSha256: digest,
  }),
  target: z.strictObject({
    dockerExecutable: absolute,
    dockerHost: z.literal('unix:///var/run/docker.sock'),
    dockerConfigDirectory: absolute,
    expectedDaemonId: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/),
    ownerId: identifier,
    targetId: identifier,
    composeFile: absolute,
    composeSha256: digest,
    environmentFile: absolute,
    environmentSha256: digest,
    projectName: identifier,
    volumes: z.strictObject({
      appSecrets: identifier,
      pgSecrets: identifier,
      pgData: identifier,
      caddyData: identifier,
    }),
  }),
  receiptDirectory: absolute,
});
export type TargetInput = z.infer<typeof targetInput>;
const images = z
  .array(
    z.strictObject({
      target: z.enum(['server', 'engine', 'migrate']),
      id: imageId,
      revision,
      sourceTreeSha256: digest,
    }),
  )
  .length(3);
const artifactReceipt = z.strictObject({
  version: z.literal(1),
  runId: z.uuid(),
  outcome: z.literal('artifact-preflight-passed'),
  sourceRevision: revision,
  manifestSha256: digest,
  sourceTreeSha256: digest,
  checkedAt: z.iso.datetime(),
  imageIds: images,
  webFiles: z.number().int().positive(),
  migrations: z.number().int().positive(),
  dataContract: z.literal('unknown'),
  deploymentStarted: z.literal(false),
  currentChanged: z.literal(false),
  rollbackAuthorized: z.literal(false),
});
type ArtifactReceipt = z.infer<typeof artifactReceipt>;
export const volumePurposes = {
  appSecrets: 'app-secrets',
  pgSecrets: 'pg-secrets',
  pgData: 'pg-data',
  caddyData: 'caddy-data',
} as const;
export const nonsecretKeys = [
  'SERVER_IMAGE',
  'ENGINE_IMAGE',
  'MIGRATE_IMAGE',
  'PUBLIC_HOST',
  'PUBLIC_ORIGIN',
  'BIND_ADDRESS',
  'HTTP_PORT',
  'HTTPS_PORT',
  'MAIL_FROM',
  'POSTGRES_USER',
  'POSTGRES_DB',
  'PUBLIC_WEB_DIRECTORY',
  'APP_SECRETS_VOLUME',
  'PG_SECRETS_VOLUME',
  'PG_DATA_VOLUME',
  'CADDY_DATA_VOLUME',
] as const;
export const officialImages = {
  postgres: 'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873',
  caddy: 'caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f',
} as const;
const message = '운영 대상 metadata 사전 확인을 마치지 못했습니다.';
export class TargetPreflightError extends Error {
  readonly stickyUnsettled: boolean;
  constructor(
    readonly code: string,
    readonly nativeSettlement?: Readonly<{
      actualClose: boolean;
      stdoutEnded: boolean;
      stderrEnded: boolean;
      groupAbsent: boolean | null;
      handlesReleased: boolean;
    }>,
  ) {
    super(message);
    this.stickyUnsettled = code === 'NATIVE_UNSETTLED';
  }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new TargetPreflightError(code);
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, child: string) => {
  const p = relative(resolve(parent), resolve(child));
  return p === '' || (!p.startsWith('..' + sep) && p !== '..' && !isAbsolute(p));
};
function record(value: unknown): Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'MODEL');
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(record(value))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
async function directory(path: string) {
  let current = resolve(path);
  for (;;) {
    const s = await lstat(current);
    need(s.isDirectory() && !s.isSymbolicLink(), 'PATH');
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function boundFile(path: string, expected?: string) {
  await directory(dirname(path));
  const s = await lstat(path);
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 4 * 1024 * 1024, 'FILE');
  const bytes = await readFile(path);
  const result = await hashFile(path);
  need(result.sha256 === sha(bytes) && (expected === undefined || expected === result.sha256), 'HASH');
  return bytes;
}
export function parseTargetEnvironment(text: string) {
  need(!/[\0\r]/.test(text) && Buffer.byteLength(text) <= 65536, 'ENV');
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line === '' || /^\s*#/.test(line)) continue;
    const m = /^([A-Z_]+)=([^\s\x7f$`"'\\#]+)$/.exec(line);
    need(m && nonsecretKeys.includes(m[1] as (typeof nonsecretKeys)[number]) && values[m[1]!] === undefined, 'ENV');
    values[m[1]!] = m[2]!;
  }
  need(nonsecretKeys.every((key) => values[key] !== undefined) && Object.keys(values).length === 16, 'ENV');
  for (const key of ['SERVER_IMAGE', 'ENGINE_IMAGE', 'MIGRATE_IMAGE'])
    need(imageId.safeParse(values[key]).success, 'ENV');
  need(z.ipv4().safeParse(values.BIND_ADDRESS).success, 'ENV');
  for (const key of ['HTTP_PORT', 'HTTPS_PORT'])
    need(/^[1-9][0-9]{0,4}$/.test(values[key]!) && Number(values[key]) <= 65535, 'ENV');
  need(values.HTTP_PORT !== values.HTTPS_PORT, 'ENV');
  need(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(values.PUBLIC_HOST!) && !values.PUBLIC_HOST!.includes('..'), 'ENV');
  const origin = new URL(values.PUBLIC_ORIGIN!);
  need(
    origin.protocol === 'https:' &&
      origin.hostname === values.PUBLIC_HOST &&
      !origin.username &&
      !origin.password &&
      origin.origin === values.PUBLIC_ORIGIN,
    'ENV',
  );
  need(/^[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+$/.test(values.MAIL_FROM!), 'ENV');
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB']) need(/^[a-z][a-z0-9_]{0,62}$/.test(values[key]!), 'ENV');
  need(isAbsolute(values.PUBLIC_WEB_DIRECTORY!), 'ENV');
  for (const key of ['APP_SECRETS_VOLUME', 'PG_SECRETS_VOLUME', 'PG_DATA_VOLUME', 'CADDY_DATA_VOLUME'])
    need(identifier.safeParse(values[key]).success, 'ENV');
  return values;
}

// Linux detached creates an owned CLI process group, never the Docker daemon group.
// Native stdout/stderr never escape; success requires close, both EOFs and group absence.
export async function runTargetNative(executable: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  return await new Promise<string>((resolveRun, reject) => {
    let output = '',
      failed = false,
      closed = false,
      outEnd = false,
      errEnd = false,
      done = false,
      uncertainGroup = false,
      observedGroupAbsent = false;
    const linux = process.platform === 'linux';
    const child = spawn(executable, args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: linux,
    });
    const group =
      linux && child.pid !== undefined && Number.isSafeInteger(child.pid) && child.pid > 1 && child.pid !== process.pid
        ? child.pid
        : undefined;
    let settle: NodeJS.Timeout | undefined;
    let groupPoll: NodeJS.Timeout | undefined;
    const groupAbsent = (): boolean | null => {
      if (!linux) return null;
      if (observedGroupAbsent) return true;
      if (group === undefined || uncertainGroup) return false;
      try {
        process.kill(-group, 0);
        return false;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          observedGroupAbsent = true;
          return true;
        }
        uncertainGroup = true;
        return false;
      }
    };
    const clearOwned = () => {
      clearTimeout(timer);
      if (settle) clearTimeout(settle);
      if (groupPoll) clearInterval(groupPoll);
      signal.removeEventListener('abort', cancel);
    };
    const finish = () => {
      if (done || !closed || !outEnd || !errEnd) return;
      if (linux && !groupAbsent()) {
        groupPoll ??= setInterval(finish, 25);
        return;
      }
      done = true;
      clearOwned();
      if (failed || signal.aborted) reject(new TargetPreflightError('NATIVE'));
      else resolveRun(output);
    };
    const cancel = () => {
      if (done) return;
      failed = true;
      if (linux && group !== undefined && !groupAbsent()) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) uncertainGroup = true;
        }
      } else if (!linux || group === undefined) {
        try {
          child.kill('SIGKILL');
        } catch {
          uncertainGroup = true;
        }
      }
      settle ??= setTimeout(() => {
        if (done) return;
        done = true;
        const facts = { actualClose: closed, stdoutEnded: outEnd, stderrEnded: errEnd, groupAbsent: groupAbsent() };
        clearOwned();
        // Unknown descendants stay unknown. Release only our local handles, never report EOF/close.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(
          new TargetPreflightError(
            'NATIVE_UNSETTLED',
            Object.freeze({ ...facts, handlesReleased: child.stdout.destroyed && child.stderr.destroyed }),
          ),
        );
      }, 60000);
    };
    const timer = setTimeout(cancel, 10000);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 4 * 1024 * 1024) cancel();
      else output += chunk.toString('utf8');
    });
    // Always drain stderr, including after failure, without retaining native messages.
    child.stderr.on('data', () => {});
    child.stdout.on('end', () => {
      outEnd = true;
      finish();
    });
    child.stderr.on('end', () => {
      errEnd = true;
      finish();
    });
    child.stdout.on('error', cancel);
    child.stderr.on('error', cancel);
    child.on('error', cancel);
    child.on('exit', () => {
      if (linux) groupAbsent();
    });
    child.on('close', (code, childSignal) => {
      closed = true;
      failed ||= code !== 0 || childSignal !== null;
      finish();
    });
    if (signal.aborted) cancel();
  });
}
type Native = typeof runTargetNative;

export function verifyTargetImages(value: unknown, receipt: ArtifactReceipt, architecture?: string) {
  const rows = z
    .array(
      z.object({
        Id: imageId,
        Os: z.literal('linux'),
        Architecture: z.string().min(1),
        Config: z.object({
          User: z.string(),
          Labels: z.record(z.string(), z.string()).nullable(),
          Env: z.array(z.string()).nullable(),
        }),
      }),
    )
    .length(3)
    .parse(value);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      expected = receipt.imageIds[i]!;
    need(row.Id === expected.id && row.Config.User === '10001:10001', 'IMAGE');
    need(
      row.Config.Labels?.['org.opencontainers.image.revision'] === receipt.sourceRevision &&
        row.Config.Labels?.['org.opensamguk.source-tree-sha256'] === receipt.sourceTreeSha256,
      'IMAGE',
    );
    need(
      row.Architecture === rows[0]!.Architecture && (architecture === undefined || row.Architecture === architecture),
      'IMAGE',
    );
    need(
      row.Config.Env?.includes('NODE_ENV=production') &&
        !row.Config.Env.some((v) => /^(?:DATABASE_URL|[A-Z_]*(?:KEY|TOKEN|PASSWORD|SECRET)[A-Z_]*)=/.test(v)),
      'IMAGE',
    );
  }
  return rows;
}
export function verifyTargetVolumes(value: unknown, target: TargetInput['target']) {
  const rows = z
    .array(
      z.object({
        Name: identifier,
        Driver: z.literal('local'),
        Scope: z.literal('local'),
        CreatedAt: z.string().min(1),
        Mountpoint: z.string().min(1),
        Labels: z.record(z.string(), z.string()),
        Options: z.record(z.string(), z.string()).nullable(),
      }),
    )
    .length(4)
    .parse(value);
  need(new Set(Object.values(target.volumes)).size === 4, 'VOLUME');
  for (const [key, purpose] of Object.entries(volumePurposes)) {
    const name = target.volumes[key as keyof typeof volumePurposes];
    const matches = rows.filter((r) => r.Name === name);
    need(matches.length === 1, 'VOLUME');
    const row = matches[0]!;
    need(row.Options === null || Object.keys(row.Options).length === 0, 'VOLUME');
    need(
      row.Labels['org.opensamguk.owner'] === target.ownerId &&
        row.Labels['org.opensamguk.target'] === target.targetId &&
        row.Labels['org.opensamguk.purpose'] === purpose,
      'VOLUME',
    );
  }
  return rows;
}

function interpolate(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string')
    return value.replace(/\$\{([A-Z_]+):\?\}/g, (_, key: string) => {
      need(env[key] !== undefined, 'COMPOSE');
      return env[key]!;
    });
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(record(value)).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}
// Normalize only documented Compose defaults; unsupported changes remain visible.
export function normalizedCompose(value: unknown, project: string, deployDirectory: string) {
  const model = structuredClone(record(value));
  model.name ??= project;
  const services = record(model.services);
  for (const raw of Object.values(services)) {
    const service = record(raw);
    if (service.networks)
      service.networks = Array.isArray(service.networks)
        ? Object.fromEntries(service.networks.map((name) => [String(name), {}]))
        : Object.fromEntries(Object.entries(record(service.networks)).map(([name, v]) => [name, v ?? {}]));
    if (service.depends_on)
      for (const dependency of Object.values(record(service.depends_on))) {
        const d = record(dependency);
        if (d.required === true) delete d.required;
      }
    if (service.ports)
      service.ports = (service.ports as unknown[]).map((v) => {
        if (typeof v === 'string') {
          const m = /^([0-9.]+):([0-9]+):([0-9]+)$/.exec(v);
          need(m, 'COMPOSE');
          return { host_ip: m[1], published: m[2], target: Number(m[3]) };
        }
        const p = record(v);
        if (p.mode === 'ingress') delete p.mode;
        if (p.protocol === 'tcp') delete p.protocol;
        if (p.published !== undefined) p.published = String(p.published);
        return p;
      });
    if (service.volumes)
      service.volumes = (service.volumes as unknown[]).map((v) => {
        const mount = record(v);
        if (mount.read_only === false) delete mount.read_only;
        if (mount.volume && Object.keys(record(mount.volume)).length === 0) delete mount.volume;
        if (mount.type === 'bind' && typeof mount.source === 'string')
          mount.source = resolve(deployDirectory, mount.source);
        return mount;
      });
  }
  for (const [name, raw] of Object.entries(record(model.networks))) {
    const network = record(raw ?? {});
    network.name ??= project + '_' + name;
    model.networks = { ...record(model.networks), [name]: network };
  }
  // Compose may retain root extension definitions; they cannot affect the resolved services.
  for (const key of Object.keys(model)) if (key.startsWith('x-')) delete model[key];
  return model;
}
export function verifyTargetCompose(
  rendered: unknown,
  trustedTemplate: string,
  env: Record<string, string>,
  target: TargetInput['target'],
) {
  const expected = interpolate(parseYaml(trustedTemplate, { merge: true }), env);
  need(
    canonical(normalizedCompose(rendered, target.projectName, dirname(target.composeFile))) ===
      canonical(normalizedCompose(expected, target.projectName, dirname(target.composeFile))),
    'COMPOSE',
  );
}

async function checkPlatform(target: TargetInput['target']) {
  need(process.platform === 'linux' && process.getuid !== undefined, 'PLATFORM');
  const executable = await lstat(target.dockerExecutable);
  need(
    executable.isFile() &&
      !executable.isSymbolicLink() &&
      executable.uid === 0 &&
      (executable.mode & 0o022) === 0 &&
      (executable.mode & 0o6000) === 0 &&
      (executable.mode & 0o111) !== 0,
    'EXECUTABLE',
  );
  need((await realpath(target.dockerExecutable)) === target.dockerExecutable, 'EXECUTABLE');
  let parent = dirname(target.dockerExecutable);
  for (;;) {
    const s = await lstat(parent);
    need(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o022) === 0, 'EXECUTABLE');
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const socketPath = await realpath('/var/run/docker.sock');
  need(socketPath === '/run/docker.sock' || socketPath === '/var/run/docker.sock', 'SOCKET');
  const socket = await lstat(socketPath);
  need(socket.isSocket() && socket.uid === 0 && (socket.mode & 0o002) === 0, 'SOCKET');
  const socketParent = await lstat(dirname(socketPath));
  need(
    socketParent.isDirectory() &&
      !socketParent.isSymbolicLink() &&
      socketParent.uid === 0 &&
      (socketParent.mode & 0o022) === 0,
    'SOCKET',
  );
  await directory(target.dockerConfigDirectory);
  const config = await lstat(target.dockerConfigDirectory);
  need(
    config.uid === process.getuid() &&
      (config.mode & 0o777) === 0o700 &&
      (await readdir(target.dockerConfigDirectory)).length === 0,
    'CONFIG',
  );
  return canonical({
    dev: socket.dev,
    ino: socket.ino,
    uid: socket.uid,
    mode: socket.mode,
    executable: await hashFile(target.dockerExecutable),
  });
}
function immutableReceipt(receipt: ArtifactReceipt) {
  const facts: Partial<ArtifactReceipt> = { ...receipt };
  delete facts.runId;
  delete facts.checkedAt;
  return canonical(facts);
}
export async function preflightTarget(value: unknown, parentSignal?: AbortSignal) {
  const abort = new AbortController(),
    timeout = setTimeout(() => abort.abort(), 120000);
  try {
    return await performTarget(
      targetInput.parse(value),
      runTargetNative,
      parentSignal ? AbortSignal.any([abort.signal, parentSignal]) : abort.signal,
    );
  } catch (error) {
    if (error instanceof TargetPreflightError) throw error;
    throw new TargetPreflightError('INPUT_OR_IO');
  } finally {
    clearTimeout(timeout);
  }
}

// Internal seams are explicit for pure tests; the public entry always checks native Linux ownership.
export async function performTarget(input: TargetInput, native: Native, signal: AbortSignal, platform = checkPlatform) {
  signal.throwIfAborted();
  const { artifact, target } = input;
  await directory(dirname(input.receiptDirectory));
  need(!inside(dirname(artifact.manifestPath), input.receiptDirectory), 'OUTPUT');
  const original = artifactReceipt.parse(
    JSON.parse((await boundFile(artifact.preflightReceiptPath, artifact.preflightReceiptSha256)).toString('utf8')),
  );
  need(
    original.sourceRevision === artifact.sourceRevision && original.manifestSha256 === artifact.manifestSha256,
    'RECEIPT',
  );
  const platformBefore = await platform(target);
  signal.throwIfAborted();
  const envBytes = await boundFile(target.environmentFile, target.environmentSha256),
    env = parseTargetEnvironment(envBytes.toString('utf8'));
  for (const image of original.imageIds) need(env[image.target.toUpperCase() + '_IMAGE'] === image.id, 'ENV_IMAGE');
  for (const [key, purpose] of Object.entries(volumePurposes))
    need(
      env[purpose.toUpperCase().replaceAll('-', '_') + '_VOLUME'] ===
        target.volumes[key as keyof typeof volumePurposes],
      'ENV_VOLUME',
    );
  need(resolve(env.PUBLIC_WEB_DIRECTORY!) === join(dirname(artifact.manifestPath), 'payload/web'), 'ENV_WEB');
  const template = await boundFile(fileURLToPath(new URL('../deploy/compose.yml', import.meta.url)));
  need(sha(template) === target.composeSha256, 'COMPOSE_TEMPLATE');
  await boundFile(target.composeFile, target.composeSha256);
  signal.throwIfAborted();
  await mkdir(input.receiptDirectory, { mode: 0o700 });
  signal.throwIfAborted();
  const fresh = await preflightRelease({
    manifestPath: artifact.manifestPath,
    manifestSha256: artifact.manifestSha256,
    sourceRevision: artifact.sourceRevision,
    receiptDirectory: join(input.receiptDirectory, 'artifact-recheck'),
  });
  signal.throwIfAborted();
  const current = artifactReceipt.parse(
    JSON.parse((await boundFile(fresh.receiptPath, fresh.receiptSha256)).toString('utf8')),
  );
  need(immutableReceipt(original) === immutableReceipt(current), 'RECEIPT');
  const partials = (await readdir(dirname(artifact.manifestPath))).filter((v) => /^\.partial-[a-f0-9-]{36}$/.test(v));
  need(
    partials.length === 1 &&
      target.composeFile === join(dirname(artifact.manifestPath), partials[0]!, 'context/deploy/compose.yml'),
    'COMPOSE_PATH',
  );
  const prefix = ['--host', target.dockerHost, '--config', target.dockerConfigDirectory];
  const docker = async (args: string[]) => {
    signal.throwIfAborted();
    const raw = await native(target.dockerExecutable, [...prefix, ...args], signal);
    signal.throwIfAborted();
    return raw;
  };
  const json = async (args: string[]) => JSON.parse(await docker(args)) as unknown;
  const info = async () => {
    const v = record(
      await json([
        'info',
        '--format',
        '{"ID":{{json .ID}},"OSType":{{json .OSType}},"Architecture":{{json .Architecture}}}',
      ]),
    );
    need(v.ID === target.expectedDaemonId && v.OSType === 'linux' && typeof v.Architecture === 'string', 'DAEMON');
    return v;
  };
  await json(['version', '--format', '{{json .}}']);
  const beforeInfo = await info();
  // --format emits one JSON object per image/volume, not a JSON array.
  const lines = async (args: string[]) =>
    (await docker(args))
      .trim()
      .split('\n')
      .map((v) => JSON.parse(v) as unknown);
  const imageArgs = [
    'image',
    'inspect',
    ...current.imageIds.map((v) => v.id),
    '--format',
    '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Config":{"User":{{json .Config.User}},"Labels":{{json .Config.Labels}},"Env":{{json .Config.Env}}}}',
  ];
  const beforeImages = verifyTargetImages(await lines(imageArgs), current);
  const architecture = beforeImages[0]!.Architecture;
  need(
    ({ x86_64: 'amd64', aarch64: 'arm64' } as Record<string, string>)[String(beforeInfo.Architecture)] ===
      architecture || beforeInfo.Architecture === architecture,
    'ARCHITECTURE',
  );
  const officialArgs = [
    'image',
    'inspect',
    officialImages.postgres,
    officialImages.caddy,
    '--format',
    '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}}}',
  ];
  const officials = await lines(officialArgs);
  need(officials.length === 2, 'IMAGE');
  officials.forEach((raw, i) => {
    const row = record(raw);
    need(
      imageId.safeParse(row.Id).success &&
        row.Os === 'linux' &&
        row.Architecture === architecture &&
        Array.isArray(row.RepoDigests) &&
        row.RepoDigests.includes(Object.values(officialImages)[i]!.replace(/:[^:@]+@/, '@')),
      'IMAGE',
    );
  });
  const volumeArgs = [
    'volume',
    'inspect',
    ...Object.values(target.volumes),
    '--format',
    '{"Name":{{json .Name}},"Driver":{{json .Driver}},"Scope":{{json .Scope}},"CreatedAt":{{json .CreatedAt}},"Mountpoint":{{json .Mountpoint}},"Labels":{{json .Labels}},"Options":{{json .Options}}}',
  ];
  const beforeVolumes = verifyTargetVolumes(await lines(volumeArgs), target);
  const model = await json([
    'compose',
    '--project-name',
    target.projectName,
    '--env-file',
    target.environmentFile,
    '-f',
    target.composeFile,
    '--profile',
    'tools',
    'config',
    '--format',
    'json',
  ]);
  verifyTargetCompose(model, template.toString('utf8'), env, target);
  need(canonical(await info()) === canonical(beforeInfo), 'REPLACED');
  need(canonical(await lines(imageArgs)) === canonical(beforeImages), 'REPLACED');
  need(canonical(await lines(officialArgs)) === canonical(officials), 'REPLACED');
  need(canonical(verifyTargetVolumes(await lines(volumeArgs), target)) === canonical(beforeVolumes), 'REPLACED');
  need((await platform(target)) === platformBefore, 'REPLACED');
  signal.throwIfAborted();
  const finalArtifact = await preflightRelease({
    manifestPath: artifact.manifestPath,
    manifestSha256: artifact.manifestSha256,
    sourceRevision: artifact.sourceRevision,
    receiptDirectory: join(input.receiptDirectory, 'artifact-final-recheck'),
  });
  signal.throwIfAborted();
  const finalFacts = artifactReceipt.parse(
    JSON.parse((await boundFile(finalArtifact.receiptPath, finalArtifact.receiptSha256)).toString('utf8')),
  );
  need(immutableReceipt(finalFacts) === immutableReceipt(current), 'REPLACED');
  await boundFile(target.environmentFile, target.environmentSha256);
  await boundFile(target.composeFile, target.composeSha256);
  await boundFile(artifact.preflightReceiptPath, artifact.preflightReceiptSha256);
  await boundFile(artifact.manifestPath, artifact.manifestSha256);
  signal.throwIfAborted();
  const receipt = {
    version: 1,
    runId: randomUUID(),
    outcome: 'target-metadata-preflight-passed',
    checkedAt: new Date().toISOString(),
    sourceRevision: current.sourceRevision,
    sourceTreeSha256: current.sourceTreeSha256,
    manifestSha256: artifact.manifestSha256,
    artifactReceiptSha256: artifact.preflightReceiptSha256,
    freshArtifactReceiptSha256: fresh.receiptSha256,
    finalArtifactReceiptSha256: finalArtifact.receiptSha256,
    composeSha256: target.composeSha256,
    environmentSha256: target.environmentSha256,
    metadataSha256: sha(
      canonical({ info: beforeInfo, images: beforeImages, officials, volumes: beforeVolumes, model }),
    ),
    images: 3,
    officialImages: 2,
    volumes: 4,
    dataContract: 'unknown',
    deploymentStarted: false,
    currentChanged: false,
    rollbackAuthorized: false,
    dbQueried: false,
    secretsRead: false,
    secretUidModeVerified: false,
    operationalReady: false,
  };
  const temporary = join(input.receiptDirectory, 'receipt.partial.json'),
    final = join(input.receiptDirectory, 'receipt.json');
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  signal.throwIfAborted();
  need((await readFile(temporary, 'utf8')) === bytes, 'OUTPUT');
  signal.throwIfAborted();
  await link(temporary, final);
  signal.throwIfAborted();
  await unlink(temporary);
  signal.throwIfAborted();
  return { receiptPath: final, receiptSha256: sha(bytes) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    need(process.argv.length === 4 && process.argv[2] === '--target-preflight' && isAbsolute(process.argv[3]!), 'MODE');
    const result = await preflightTarget(
      JSON.parse((await boundFile(process.argv[3]!)).toString('utf8')),
      stopped.signal,
    );
    console.log(JSON.stringify({ outcome: 'target-metadata-preflight-passed', receiptSha256: result.receiptSha256 }));
  } catch {
    console.error(message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
