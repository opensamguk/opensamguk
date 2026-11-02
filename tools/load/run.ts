import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { admissionSite, composeBudget, evaluateAdmission, LOAD_LIMITS, type Admission } from './admission';
import { loadDatabaseName } from './contract';
import { assertDockerParent, assertRunningDockerParent, bindLocalDocker, LOAD_DOCKER } from './docker';
import { OwnedCommands, mayDeleteOwnedData, sourceSnapshot, writeEvidence } from './lifecycle';
import {
  observationFromCounters,
  parseCpuCounter,
  parseMemory,
  readRunnerProvenance,
  sampleAdmission,
} from './observe';
import { readCommitMetrics } from './metricFiles';
import { saveLoadReport } from './reportFiles';
import { loadRunSchema, type LoadRun } from './report';

const PG_IMAGE = 'postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const services = ['postgres', 'server', 'engine', 'generator'] as const;
const volumes = ['pg-data', 'pg-secrets', 'app-secrets', 'evidence'] as const;
type Container = {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean; OOMKilled: boolean; ExitCode: number; FinishedAt: string; Pid?: number };
  Image?: string;
  HostConfig?: {
    NanoCpus: number;
    Memory: number;
    MemorySwap: number;
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    CgroupParent?: string;
    PortBindings: Record<string, Array<{ HostIp: string }>> | null;
  };
};
const auxiliaryRoles = ['initialize', 'migrations', 'resources', 'witness'] as const;
export function partitionOwnedContainers(rows: readonly Container[], project: string, runId: string) {
  const primary: Container[] = [],
    auxiliary: Container[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const labels = row.Config.Labels;
    if (
      !/^[a-f0-9]{64}$/.test(row.Id) ||
      ids.has(row.Id) ||
      labels['com.docker.compose.project'] !== project ||
      labels['org.opensamguk.load.run'] !== runId
    )
      throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
    ids.add(row.Id);
    const role = auxiliaryRoles.find((role) => row.Name === `/${project}-${role}`);
    if (role) auxiliary.push(row);
    else {
      if (
        labels['com.docker.compose.oneoff'] === 'True' ||
        !services.includes(labels['com.docker.compose.service'] as (typeof services)[number])
      )
        throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
      primary.push(row);
    }
  }
  return { primary, auxiliary };
}
function dictionary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LOAD_RUNTIME_METADATA_INVALID');
  return value as Record<string, unknown>;
}

export function renderLoadCompose(source: string, mode: 'formal' | 'smoke'): string {
  // smoke도 같은 정식 2월드 고정물을 쓰되 동시 사용자와 자원만 별도로 제한한다.
  const document = dictionary(parse(source, { merge: true })),
    rows = dictionary(document.services);
  for (const name of services) {
    const row = dictionary(rows[name]);
    assertDockerParent(row.cgroup_parent, LOAD_DOCKER);
    if (
      name !== 'postgres' &&
      JSON.stringify(row.tmpfs) !== JSON.stringify(['/tmp:rw,noexec,nosuid,size=64m,mode=1777'])
    )
      throw new Error('LOAD_COMPOSE_TMPFS_INVALID');
  }
  if (mode === 'smoke') {
    const limits = {
      postgres: [0.5, '1g'],
      server: [0.25, '512m'],
      engine: [0.25, '512m'],
      generator: [0.25, '512m'],
    } as const;
    for (const name of services)
      Object.assign(dictionary(rows[name]), {
        cpus: limits[name][0],
        mem_limit: limits[name][1],
        memswap_limit: limits[name][1],
      });
  }
  const text = stringify(document);
  composeBudget(text, mode);
  return text;
}

export function assertContainerOwnership(rows: readonly Container[], project: string, runId: string): void {
  if (rows.length !== 4 || new Set(rows.map((row) => row.Id)).size !== 4)
    throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
  const actual = new Set<string>();
  for (const row of rows) {
    assertDockerParent(row.HostConfig?.CgroupParent, LOAD_DOCKER);
    const labels = row.Config.Labels;
    const service = labels['com.docker.compose.service'];
    if (
      !/^[a-f0-9]{64}$/.test(row.Id) ||
      labels['com.docker.compose.project'] !== project ||
      labels['org.opensamguk.load.run'] !== runId ||
      !service ||
      !services.includes(service as (typeof services)[number]) ||
      actual.has(service)
    )
      throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
    actual.add(service);
  }
}

export function assertContainerLimits(
  rows: readonly Container[],
  mode: 'formal' | 'smoke',
  image: string,
  postgresImage: string,
) {
  for (const row of rows) {
    assertDockerParent(row.HostConfig?.CgroupParent, LOAD_DOCKER);
    const service = row.Config.Labels['com.docker.compose.service'];
    const cpus =
      service === 'postgres'
        ? mode === 'formal'
          ? 1
          : 0.5
        : service === 'generator'
          ? mode === 'formal'
            ? 1
            : 0.25
          : mode === 'formal'
            ? 0.5
            : 0.25;
    const memory = (service === 'postgres' ? (mode === 'formal' ? 2 : 1) : mode === 'formal' ? 1 : 0.5) * 1024 ** 3;
    const host = row.HostConfig;
    if (
      !host ||
      host.NanoCpus !== cpus * 1e9 ||
      host.Memory !== memory ||
      host.MemorySwap !== memory ||
      host.Privileged ||
      !host.ReadonlyRootfs ||
      row.Image !== (service === 'postgres' ? postgresImage : image)
    )
      throw new Error('LOAD_CONTAINER_LIMITS_UNVERIFIED');
    for (const bindings of Object.values(host.PortBindings ?? {})) {
      if (service !== 'server' || bindings.some((binding) => binding.HostIp !== '127.0.0.1'))
        throw new Error('LOAD_CONTAINER_PORT_UNVERIFIED');
    }
  }
}

function numericOption(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('LOAD_OPTIONS_INVALID');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('LOAD_OPTIONS_INVALID');
  return number;
}

export function requireImageSource(raw: unknown, head: string, sha256: string): string {
  if (!Array.isArray(raw) || raw.length !== 1) throw new Error('LOAD_IMAGE_SOURCE_INVALID');
  const row = dictionary(raw[0]),
    config = dictionary(row.Config),
    labels = dictionary(config.Labels);
  if (
    labels['org.opencontainers.image.revision'] !== head ||
    labels['org.opensamguk.source-tree-sha256'] !== sha256 ||
    typeof row.Id !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(row.Id)
  )
    throw new Error('LOAD_IMAGE_SOURCE_INVALID');
  return row.Id;
}

export function verifyDatabaseIdentity(
  text: string,
  expected: { name: string; oid?: number },
): { name: string; oid: number; connections: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('LOAD_DATABASE_IDENTITY_INVALID');
  }
  const row = dictionary(raw);
  if (
    row.name !== expected.name ||
    typeof row.oid !== 'number' ||
    !Number.isSafeInteger(row.oid) ||
    row.oid <= 0 ||
    typeof row.connections !== 'number' ||
    !Number.isSafeInteger(row.connections) ||
    row.connections < 0 ||
    (expected.oid !== undefined && row.oid !== expected.oid)
  )
    throw new Error('LOAD_DATABASE_IDENTITY_INVALID');
  return { name: row.name, oid: row.oid, connections: row.connections };
}

const initializeSecrets = `
const fs=require('node:fs'),crypto=require('node:crypto');
const password=crypto.randomBytes(48).toString('base64url');
const database=process.env.LOAD_DATABASE;
if(!/^opensamguk_load_[a-f0-9]{32}_test$/.test(database||''))process.exit(1);
for(const name of ['app','pg','data','evidence'])fs.chmodSync('/owned/'+name,0o700);
for(const [dir,name,value,uid] of [['app','database_url','postgresql://load:'+password+'@postgres/'+database,10001],['pg','pg_password',password,70]]){
 const path='/owned/'+dir+'/'+name;fs.writeFileSync(path,value,{flag:'wx',mode:0o600});fs.chownSync(path,uid,uid);
}
for(const [name,uid] of [['app',10001],['pg',70],['data',70],['evidence',10001]])fs.chownSync('/owned/'+name,uid,uid);`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      run: { type: 'string' },
      mode: { type: 'string', default: 'formal' },
      site: { type: 'string' },
      wait: { type: 'string' },
      keep: { type: 'boolean', default: false },
      image: { type: 'string' },
      'source-head': { type: 'string' },
      'source-sha256': { type: 'string' },
    },
  });
  const runId = values.run ?? randomUUID().replaceAll('-', ''),
    mode = values.mode;
  if (mode !== 'formal' && mode !== 'smoke') throw new Error('LOAD_OPTIONS_INVALID');
  const databaseName = loadDatabaseName(runId),
    project = `opensamguk-load-${runId}`;
  const site = admissionSite(values.site, await readRunnerProvenance());
  // Windows·공용 풀 미설정 경로는 Docker/DB에 접속하기 전에 거부한다.
  if (!site.accepted) {
    process.stdout.write(`${site.reason}\n`);
    return 75;
  }
  if (values.keep && site.site !== 'github-hosted') throw new Error('LOAD_KEEP_FORBIDDEN');
  const expectedHead = values['source-head'] ?? '',
    expectedSource = values['source-sha256'] ?? '',
    image = values.image ?? '';
  if (
    !/^[a-f0-9]{40}$/.test(expectedHead) ||
    !/^[a-f0-9]{64}$/.test(expectedSource) ||
    !/^sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error('LOAD_SOURCE_PIN_REQUIRED');
  const waitMinutes = numericOption(values.wait, 0);
  if (waitMinutes > 10) throw new Error('LOAD_WAIT_LIMIT');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    commands = new OwnedCommands(root);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const signal = controller.signal;
  const output = resolve(root, '.load-reports', runId);
  // UUID가 같은 기존 실행은 재사용하거나 덮어쓰지 않는다.
  await mkdir(output, { recursive: false, mode: 0o700 }).catch(async () => {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await mkdir(output, { recursive: false, mode: 0o700 });
  });
  const rawDocker = async (
    args: readonly string[],
    label: string,
    ownSignal = signal,
    timeoutMs = 10_000,
    env?: NodeJS.ProcessEnv,
  ) => commands.run('docker', args, { label, signal: ownSignal, timeoutMs, ...(env ? { env } : {}) });
  const docker = await bindLocalDocker(rawDocker, signal);
  const native = (
    args: readonly string[],
    label: string,
    ownSignal = signal,
    timeoutMs = 10_000,
    env?: NodeJS.ProcessEnv,
  ) => docker.run(args, label, ownSignal, timeoutMs, env);
  const before = await sourceSnapshot(commands, signal);
  if (before.head !== expectedHead || before.sha256 !== expectedSource) throw new Error('LOAD_SOURCE_PIN_MISMATCH');
  await writeEvidence(resolve(output, 'source-before.json'), before);
  const composeText = renderLoadCompose(await readFile(resolve(root, 'deploy/load/compose.yml'), 'utf8'), mode);
  const budget = composeBudget(composeText, mode),
    composePath = resolve(output, 'compose.yml');
  await writeFile(composePath, composeText, { flag: 'wx', mode: 0o600 });
  const info = dictionary(
    JSON.parse(
      await native(
        [
          'info',
          '--format',
          '{"root":{{json .DockerRootDir}},"driver":{{json .CgroupDriver}},"version":{{json .CgroupVersion}},"os":{{json .OSType}},"security":{{json .SecurityOptions}}}',
        ],
        'docker-information',
      ),
    ),
  );
  if (
    info.os !== 'linux' ||
    info.version !== '2' ||
    info.driver !== 'systemd' ||
    typeof info.root !== 'string' ||
    !Array.isArray(info.security) ||
    info.security.some((item) => typeof item !== 'string' || item.includes('rootless'))
  )
    throw new Error('LOAD_DOCKER_ISOLATION_UNVERIFIED');
  const startedAdmission = Date.now();
  let admission: Admission;
  do {
    const sample = await sampleAdmission({
      dockerDataPath: info.root,
      reportPath: output,
      dockerCgroupPath: docker.binding.cgroupPath,
      signal,
    });
    admission = evaluateAdmission(site, sample, budget, {
      now: Date.now(),
      cpuPercent: numericOption(process.env.LOAD_ADMISSION_CPU_PERCENT, 80),
      memoryPercent: numericOption(process.env.LOAD_ADMISSION_MEMORY_PERCENT, 80),
      diskReserveMiB: numericOption(process.env.LOAD_ADMISSION_DISK_RESERVE_MIB, 2048),
    });
    await writeEvidence(resolve(output, `admission-${sample.at}.json`), { admission, sample, budget, project });
    if (admission.accepted) break;
  } while (Date.now() - startedAdmission < waitMinutes * 60_000);
  const admissionText = JSON.stringify({ admission, budget, project, source: before, docker: docker.binding });
  await writeFile(resolve(output, 'admission.json'), admissionText + '\n', { flag: 'wx', mode: 0o600 });
  if (!admission.accepted) {
    process.stdout.write(`${admission.reason}\n`);
    return 75;
  }
  requireImageSource(
    JSON.parse(await native(['image', 'inspect', image], 'image-source')),
    expectedHead,
    expectedSource,
  );
  const pgImages: unknown = JSON.parse(await native(['image', 'inspect', PG_IMAGE], 'postgres-image'));
  if (!Array.isArray(pgImages) || pgImages.length !== 1) throw new Error('LOAD_POSTGRES_IMAGE_MISSING');
  const postgresImage = dictionary(pgImages[0]).Id;
  if (typeof postgresImage !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(postgresImage))
    throw new Error('LOAD_POSTGRES_IMAGE_MISSING');
  const bodyStartedAt = Date.now(),
    bodyDeadline = bodyStartedAt + LOAD_LIMITS.bodyMs;
  const setupDeadline = bodyStartedAt + LOAD_LIMITS.setupMs;
  const bodyTimer = setTimeout(stop, LOAD_LIMITS.bodyMs);
  // 취소를 처리하지 못하는 커널/파일 IO도 유한하게 끝낸다. 이 경로는 정착·삭제 성공을 주장하지 않는다.
  const hardTimer = setTimeout(() => {
    process.stderr.write('LOAD_LIFECYCLE_UNSETTLED_MANUAL_REVIEW_REQUIRED\n');
    process.exit(1);
  }, LOAD_LIMITS.bodyMs + LOAD_LIMITS.cleanupMs);
  const env = {
    ...process.env,
    LOAD_IMAGE: image,
    LOAD_RUN_ID: runId,
    LOAD_DATABASE: databaseName,
    LOAD_MODE: mode,
    LOAD_SETUP_DEADLINE: String(setupDeadline),
    LOAD_BODY_DEADLINE: String(bodyDeadline),
    LOAD_SOURCE_HEAD: before.head,
    LOAD_SOURCE_SHA256: before.sha256,
  };
  const compose = (args: readonly string[], label: string, ownSignal = signal, timeoutMs = 10_000) =>
    native(['compose', '-f', composePath, '-p', project, ...args], label, ownSignal, timeoutMs, env);
  const setupCompose = async (args: readonly string[], label: string, timeoutMs: number) => {
    signal.throwIfAborted();
    const remaining = setupDeadline - Date.now();
    if (remaining <= 0) throw new Error('LOAD_SETUP_DEADLINE_EXCEEDED');
    const value = await compose(args, label, signal, Math.min(remaining, timeoutMs));
    signal.throwIfAborted();
    if (Date.now() >= setupDeadline) throw new Error('LOAD_SETUP_DEADLINE_EXCEEDED');
    return value;
  };
  let created = false,
    succeeded = false,
    knownOid: number | undefined,
    ownedRows: Container[] = [];
  let complete = false,
    observeFailure = false,
    observationTask: Promise<void> | undefined;
  const observer = new AbortController();
  const observations: LoadRun['environment']['observations'] = [];
  let sourceUnchanged = false,
    finalVerdict = 'INVALID';
  const recordedParents = new Set<string>();
  const verifyActiveParent = async (row: Container, ownSignal: AbortSignal) => {
    ownSignal.throwIfAborted();
    if (!Number.isSafeInteger(row.State.Pid) || (row.State.Pid ?? 0) <= 0)
      throw new Error('LOAD_CONTAINER_CGROUP_UNVERIFIED');
    const actual = await readFile(`/proc/${row.State.Pid}/cgroup`, 'utf8');
    assertRunningDockerParent(row, actual, docker.binding);
    ownSignal.throwIfAborted();
    const key = `${row.Id}-${row.State.Pid}`;
    if (!recordedParents.has(key)) {
      await writeEvidence(resolve(output, `container-parent-${key}.json`), {
        at: Date.now(),
        id: row.Id,
        pid: row.State.Pid,
        parent: row.HostConfig?.CgroupParent,
        actualCgroup: actual,
        expected: docker.binding,
      });
      recordedParents.add(key);
    }
    ownSignal.throwIfAborted();
  };
  const inspectProject = async (ownSignal: AbortSignal) => {
    const ids = (
      await native(
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
        'owned-container-ids',
        ownSignal,
      )
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!ids.length) return { primary: [] as Container[], auxiliary: [] as Container[] };
    const rows: unknown = JSON.parse(await native(['inspect', ...ids], 'owned-container-proof', ownSignal));
    if (!Array.isArray(rows)) throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
    const parsed = rows as Container[];
    return partitionOwnedContainers(parsed, project, runId);
  };
  const inspectOwned = async (ownSignal: AbortSignal) => {
    const { primary, auxiliary } = await inspectProject(ownSignal);
    assertContainerOwnership(primary, project, runId);
    assertContainerLimits(primary, mode, image, postgresImage);
    for (const row of primary) {
      if (row.State.Running) {
        await verifyActiveParent(row, ownSignal);
      }
    }
    if (auxiliary.length) throw new Error('LOAD_AUXILIARY_CONTAINER_REMAINS');
    return primary;
  };
  // 보조 컨테이너도 DB/자원 명령 전에 idle 상태의 실제 PID와 parent를 확인한다.
  // 각 명령의 기존 총 제한 시간 안에서 create/검증/실행/정착을 모두 마친다.
  const runOwnedHelper = async (
    role: (typeof auxiliaryRoles)[number],
    createArgs: readonly string[],
    command: readonly string[],
    label: string,
    timeoutMs: number,
    setup: boolean,
    workdir?: string,
  ) => {
    const deadline = Math.min(Date.now() + timeoutMs, setup ? setupDeadline : bodyDeadline);
    const invoke = (args: readonly string[], suffix: string) => {
      signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(setup ? 'LOAD_SETUP_DEADLINE_EXCEEDED' : 'LOAD_HELPER_DEADLINE_EXCEEDED');
      return native(args, `${label}-${suffix}`, signal, remaining, env);
    };
    const id = (await invoke(createArgs, 'idle-start')).trim();
    signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
    const raw: unknown = JSON.parse(await invoke(['inspect', id], 'parent-proof'));
    if (!Array.isArray(raw) || raw.length !== 1) throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
    const rows = partitionOwnedContainers(raw as Container[], project, runId).auxiliary;
    const row = rows[0];
    if (rows.length !== 1 || !row || row.Id !== id || row.Name !== `/${project}-${role}` || row.Image !== image)
      throw new Error('LOAD_CONTAINER_OWNERSHIP_INVALID');
    if (role === 'initialize') {
      if (
        row.HostConfig?.NanoCpus !== 1e9 ||
        row.HostConfig.Memory !== 2 * 1024 ** 3 ||
        row.HostConfig.MemorySwap !== 2 * 1024 ** 3 ||
        row.HostConfig.Privileged ||
        !row.HostConfig.ReadonlyRootfs
      )
        throw new Error('LOAD_CONTAINER_LIMITS_UNVERIFIED');
    } else assertContainerLimits([row], mode, image, postgresImage);
    await verifyActiveParent(row, signal);
    signal.throwIfAborted();
    await invoke(['exec', ...(workdir ? ['--workdir', workdir] : []), id, ...command], 'execute');
    signal.throwIfAborted();
    await invoke(['stop', '--time', '1', id], 'stop');
    const stopped: unknown = JSON.parse(await invoke(['inspect', id], 'exit-proof'));
    if (!Array.isArray(stopped) || stopped.length !== 1) throw new Error('LOAD_CONTAINER_NORMAL_EXIT_UNCONFIRMED');
    const final = partitionOwnedContainers(stopped as Container[], project, runId).auxiliary[0];
    if (
      !final ||
      final.Id !== id ||
      final.State.Running ||
      final.State.Pid !== 0 ||
      final.State.ExitCode !== 0 ||
      final.State.OOMKilled ||
      !final.State.FinishedAt ||
      final.State.FinishedAt.startsWith('0001-')
    )
      throw new Error('LOAD_CONTAINER_NORMAL_EXIT_UNCONFIRMED');
    await invoke(['rm', id], 'remove');
    signal.throwIfAborted();
  };
  const idle = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const helperArgs = (role: (typeof auxiliaryRoles)[number]) => [
    'compose',
    '-f',
    composePath,
    '-p',
    project,
    'run',
    '-d',
    '--no-deps',
    '--name',
    `${project}-${role}`,
    'generator',
    'node',
    '-e',
    idle,
  ];
  const databaseIdentity = async (ownSignal: AbortSignal) => {
    const sql = `SELECT json_build_object('name',d.datname,'oid',d.oid::int,'connections',(SELECT count(*)::int FROM pg_stat_activity WHERE datname=d.datname)) FROM pg_database d WHERE d.datname='${databaseName}'`;
    return verifyDatabaseIdentity(
      await compose(
        [
          'exec',
          '-T',
          '-e',
          'PGOPTIONS=-c statement_timeout=5000',
          'postgres',
          'psql',
          '-X',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          'load',
          '-d',
          'postgres',
          '-c',
          sql,
        ],
        'owned-database-proof',
        ownSignal,
      ),
      { name: databaseName, ...(knownOid === undefined ? {} : { oid: knownOid }) },
    );
  };
  const failures: Error[] = [];
  try {
    const collisions = await native(
      ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
      'project-baseline',
    );
    const existingVolumes = await native(
      ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
      'volume-baseline',
    );
    // 이름만 같은 무표시 볼륨도 compose가 채택하지 않게 전체 고유 이름을 확인한다.
    const volumeNames = new Set((await native(['volume', 'ls', '-q'], 'volume-names')).trim().split(/\s+/));
    const networkNames = new Set(
      (await native(['network', 'ls', '--format', '{{.Name}}'], 'network-names')).trim().split(/\s+/),
    );
    if (
      collisions.trim() ||
      existingVolumes.trim() ||
      volumes.some((name) => volumeNames.has(`${project}_${name}`)) ||
      networkNames.has(`${project}_backend`)
    )
      throw new Error('LOAD_OWNERSHIP_BASELINE_NOT_EMPTY');
    signal.throwIfAborted();
    created = true;
    await setupCompose(['create'], 'create-project', 30_000);
    ownedRows = await inspectOwned(signal);
    signal.throwIfAborted();
    if (Date.now() >= setupDeadline) throw new Error('LOAD_SETUP_DEADLINE_EXCEEDED');
    await runOwnedHelper(
      'initialize',
      [
        'run',
        '-d',
        '--name',
        `${project}-initialize`,
        '--cgroup-parent',
        docker.binding.cgroupParent,
        '--label',
        `org.opensamguk.load.run=${runId}`,
        '--label',
        `com.docker.compose.project=${project}`,
        '--network',
        'none',
        '--cpus',
        '1',
        '--memory',
        '2g',
        '--memory-swap',
        '2g',
        '--user',
        '0:0',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'CHOWN',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--entrypoint',
        'node',
        ...volumes.flatMap((name) => [
          '--mount',
          `type=volume,src=${project}_${name},dst=/owned/${{ 'pg-data': 'data', 'pg-secrets': 'pg', 'app-secrets': 'app', evidence: 'evidence' }[name]}`,
        ]),
        '-e',
        `LOAD_DATABASE=${databaseName}`,
        image,
        '-e',
        idle,
      ],
      ['node', '-e', initializeSecrets],
      'initialize-private-volumes',
      20_000,
      true,
    );
    if (Date.now() >= setupDeadline) throw new Error('LOAD_SETUP_DEADLINE_EXCEEDED');
    await setupCompose(['up', '-d', '--wait', 'postgres'], 'postgres-start', 40_000);
    await inspectOwned(signal);
    knownOid = (await databaseIdentity(signal)).oid;
    await runOwnedHelper(
      'migrations',
      helperArgs('migrations'),
      [
        'node',
        '/app/packages/db/node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--schema',
        '/app/packages/db/prisma/schema.prisma',
      ],
      'migrations',
      60_000,
      true,
      '/app/packages/db',
    );
    await runOwnedHelper(
      'resources',
      helperArgs('resources'),
      ['node', '--import', 'tsx', 'tools/load/worker.ts', 'resources'],
      'resources',
      30_000,
      true,
    );
    await setupCompose(['up', '-d', '--wait', 'server'], 'server-start', 30_000);
    await inspectOwned(signal);
    await setupCompose(['up', '-d', 'engine'], 'engine-supervisor-start', 10_000);
    await inspectOwned(signal);
    await setupCompose(['up', '-d', 'generator'], 'generator-start', 10_000);
    await inspectOwned(signal);
    observationTask = (async () => {
      const observeSignal = signal;
      let previous = parseCpuCounter(await readFile('/proc/stat', 'utf8'));
      let nextSampleAt = Date.now() + 5_000;
      while (!observeSignal.aborted && !observer.signal.aborted) {
        await delay(Math.max(0, nextSampleAt - Date.now()), undefined, {
          signal: AbortSignal.any([signal, observer.signal]),
        });
        nextSampleAt += 5_000;
        const rows = await inspectOwned(observeSignal);
        if (rows.some((row) => row.State.OOMKilled)) {
          await writeEvidence(resolve(output, `runtime-oom-${Date.now()}.json`), {
            at: Date.now(),
            oomContainers: rows.filter((row) => row.State.OOMKilled).map((row) => row.Id),
          });
          throw new Error('LOAD_RUNTIME_RESOURCE_EXHAUSTED');
        }
        const statsText = await native(
          ['stats', '--no-stream', '--format', '{{json .}}', ...rows.map((row) => row.Id)],
          'runtime-stats',
          observeSignal,
          5_000,
        );
        const stats: Array<{ ID: string; CPUPerc: string }> = statsText
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        if (stats.length !== 4) throw new Error('LOAD_RUNTIME_SAMPLE_INVALID');
        const percents = rows.map((row) => {
          const entry = stats.find((entry) => row.Id.startsWith(entry.ID));
          if (!entry || !/^[0-9]+(?:\.[0-9]+)?%$/.test(entry.CPUPerc)) throw new Error('LOAD_RUNTIME_SAMPLE_INVALID');
          return Number(entry.CPUPerc.slice(0, -1));
        });
        const generatorIndex = rows.findIndex((row) => row.Config.Labels['com.docker.compose.service'] === 'generator');
        const after = parseCpuCounter(await readFile('/proc/stat', 'utf8'));
        const cores = (await readFile('/proc/cpuinfo', 'utf8')).match(/^processor\s*:/gm)?.length ?? 0;
        const sample = observationFromCounters({
          at: Date.now(),
          before: previous,
          after,
          hostCores: cores,
          containerCpuPercent: percents,
          generatorCpuPercent: percents[generatorIndex]!,
          generatorCpuLimit: mode === 'formal' ? 1 : 0.25,
          oomCounts: rows.map((row) => (row.State.OOMKilled ? 1 : 0)),
        });
        previous = after;
        observations.push(sample);
        const memory = parseMemory(await readFile('/proc/meminfo', 'utf8'));
        await writeEvidence(resolve(output, `observation-${sample.at}.json`), {
          ...sample,
          memory,
          containerIds: rows.map((row) => row.Id),
        });
        if (sample.oomCount || memory.available === 0) throw new Error('LOAD_RUNTIME_RESOURCE_EXHAUSTED');
      }
    })().catch((error: unknown) => {
      if (!(observer.signal.aborted && error instanceof Error && error.name === 'AbortError')) {
        observeFailure = true;
        stop();
      }
    });
    const generator = ownedRows.find((row) => row.Config.Labels['com.docker.compose.service'] === 'generator')!;
    while (true) {
      signal.throwIfAborted();
      const state = (
        await native(
          [
            'exec',
            generator.Id,
            'node',
            '-e',
            "const fs=require('node:fs');process.stdout.write(fs.existsSync('/evidence/generator-completed.json')?'complete':fs.existsSync('/evidence/worker-failure.json')?'failed':fs.existsSync('/evidence/setup-completed.json')?'warming':'running')",
          ],
          'generator-phase',
          signal,
          5_000,
        )
      ).trim();
      if (state === 'failed') throw new Error('LOAD_GENERATOR_FAILED');
      if (state === 'complete') break;
      if (state !== 'running' && state !== 'warming') throw new Error('LOAD_GENERATOR_PHASE_INVALID');
      if (state === 'running' && Date.now() >= setupDeadline) throw new Error('LOAD_SETUP_DEADLINE_EXCEEDED');
      await delay(1_000, undefined, { signal });
    }
    // 끝 표본을 얻고, 감독의 정상 종료와 metric append 정착 뒤 DB를 읽는다.
    await delay(5_000, undefined, { signal });
    observer.abort();
    await observationTask;
    if (observeFailure) throw new Error('LOAD_OBSERVER_FAILED');
    await native(
      [
        'exec',
        generator.Id,
        'node',
        '-e',
        "require('node:fs').writeFileSync('/evidence/release-worker',process.env.LOAD_RUN_ID,{flag:'wx',mode:0o600})",
      ],
      'release-generator',
      signal,
      5_000,
    );
    const exit = (await native(['wait', generator.Id], 'generator-actual-exit', signal, 15_000)).trim();
    if (exit !== '0') throw new Error('LOAD_GENERATOR_FAILED');
    await compose(['stop', 'engine', 'server'], 'stop-application', signal, 50_000);
    await runOwnedHelper(
      'witness',
      helperArgs('witness'),
      ['node', '--import', 'tsx', 'tools/load/worker.ts', 'witness'],
      'final-database-witness',
      30_000,
      false,
    );
    const identity = await databaseIdentity(signal);
    if (identity.connections !== 0) throw new Error('LOAD_DATABASE_CONNECTIONS_REMAIN');
    await writeEvidence(resolve(output, 'database-before-stop.json'), identity);
    const artifactPath = resolve(output, 'artifacts');
    await mkdir(artifactPath, { mode: 0o700 });
    await native(['cp', `${generator.Id}:/evidence/.`, artifactPath], 'copy-owned-evidence', signal, 10_000);
    const fragment: unknown = JSON.parse(await readFile(resolve(artifactPath, 'fragment.json'), 'utf8'));
    const database: unknown = JSON.parse(await readFile(resolve(artifactPath, 'database-witness.json'), 'utf8'));
    const after = await sourceSnapshot(commands, signal);
    sourceUnchanged = after.head === before.head && after.sha256 === before.sha256;
    await writeEvidence(resolve(output, 'source-after.json'), after);
    const row = dictionary(fragment),
      witness = dictionary(database);
    if (typeof row.measurementStartedAt !== 'number' || typeof row.measurementFinishedAt !== 'number')
      throw new Error('LOAD_FRAGMENT_INVALID');
    const measurementStartedAt = row.measurementStartedAt,
      measurementFinishedAt = row.measurementFinishedAt;
    const beforeMeasurement = observations.findLastIndex((item) => item.at <= measurementStartedAt);
    const afterMeasurement = observations.findIndex((item) => item.at >= measurementFinishedAt);
    const selected =
      beforeMeasurement < 0 || afterMeasurement < 0 ? [] : observations.slice(beforeMeasurement, afterMeasurement + 1);
    const { complete: workerComplete, resourceManifest, ...fields } = row;
    await writeEvidence(resolve(output, 'resource-manifest.json'), resourceManifest);
    const raw = loadRunSchema.parse({
      version: 2,
      ...fields,
      sourceHead: before.head,
      sourceSha256: before.sha256,
      metrics: await readCommitMetrics(resolve(artifactPath, 'metrics.jsonl')),
      ...witness,
      environment: {
        admissionAccepted: true,
        admissionSha256: createHash('sha256')
          .update(admissionText + '\n')
          .digest('hex'),
        sourceUnchanged,
        complete: workerComplete === true && !observeFailure && selected.length > 0,
        maxGeneratorCpuFraction: selected.length ? Math.max(...selected.map((item) => item.generatorCpuFraction)) : 0,
        maxExternalHostCpuFraction: selected.length
          ? Math.max(...selected.map((item) => item.externalHostCpuFraction))
          : 0,
        oomCount: observations.reduce((maximum, item) => Math.max(maximum, item.oomCount), 0),
        observations: selected,
      },
    });
    const report = await saveLoadReport(output, raw);
    finalVerdict = report.verdict;
    succeeded = finalVerdict === 'PASS' || finalVerdict === 'SMOKE_ONLY';
    complete = true;
  } catch {
    failures.push(new Error('LOAD_BODY_FAILED'));
  }
  {
    clearTimeout(bodyTimer);
    observer.abort();
    const cleanup = new AbortController(),
      cleanupTimer = setTimeout(() => cleanup.abort(), LOAD_LIMITS.cleanupMs - 10_000);
    const cleanupHardTimer = setTimeout(() => {
      process.stderr.write('LOAD_CLEANUP_UNSETTLED_MANUAL_REVIEW_REQUIRED\n');
      process.exit(1);
    }, LOAD_LIMITS.cleanupMs);
    const cleanupFailures: string[] = [];
    let ownershipMatches = false,
      databaseOidMatches = false,
      connections: number | null = null,
      deleted = false;
    try {
      try {
        await observationTask;
      } catch {
        cleanupFailures.push('OBSERVER_UNSETTLED');
      }
      if (created) {
        let allOwned: Container[] = [];
        try {
          const group = await inspectProject(cleanup.signal);
          ownedRows = group.primary;
          allOwned = [...group.primary, ...group.auxiliary];
          assertContainerOwnership(ownedRows, project, runId);
          ownershipMatches = true;
        } catch {
          cleanupFailures.push('OWNED_SCOPE_UNCONFIRMED');
        }
        // 한 단계의 관측 실패가 실제로 소유를 확인한 프로세스들의 정리를 생략하게 하지 않는다.
        if (allOwned.length) {
          try {
            const applications = allOwned.filter(
              (row) => row.Config.Labels['com.docker.compose.service'] !== 'postgres',
            );
            if (applications.length)
              await native(
                ['stop', '--time', '20', ...applications.map((row) => row.Id)],
                'cleanup-stop-application',
                cleanup.signal,
                50_000,
              );
          } catch {
            cleanupFailures.push('APPLICATION_STOP_UNCONFIRMED');
          }
          try {
            if (
              ownedRows.some(
                (row) => row.Config.Labels['com.docker.compose.service'] === 'postgres' && row.State.Running,
              )
            ) {
              const identity = await databaseIdentity(cleanup.signal);
              databaseOidMatches = knownOid !== undefined && identity.oid === knownOid;
              connections = identity.connections;
              await writeEvidence(resolve(output, 'database-cleanup-fresh.json'), identity);
            }
          } catch {
            cleanupFailures.push('DATABASE_FINAL_PROOF_MISSING');
          }
          try {
            // --rm 보조 컨테이너는 위 stop 뒤 제거될 수 있으므로 현재 소유 목록을 다시 읽는다.
            const remaining = await inspectProject(cleanup.signal),
              ids = [...remaining.primary, ...remaining.auxiliary].map((row) => row.Id);
            if (ids.length)
              await native(['stop', '--time', '30', ...ids], 'cleanup-stop-project', cleanup.signal, 60_000);
            const stopped = await inspectOwned(cleanup.signal);
            if (
              stopped.some(
                (row) => row.State.Running || !row.State.FinishedAt || row.State.FinishedAt.startsWith('0001-'),
              )
            )
              throw new Error('LOAD_CONTAINER_NOT_STOPPED');
            if (
              succeeded &&
              stopped.some((row) => row.State.ExitCode !== 0 || row.State.Pid !== 0 || row.State.OOMKilled)
            )
              throw new Error('LOAD_CONTAINER_NORMAL_EXIT_UNCONFIRMED');
            await writeEvidence(
              resolve(output, 'containers-stopped.json'),
              stopped.map((row) => ({
                id: row.Id,
                service: row.Config.Labels['com.docker.compose.service'],
                finishedAt: row.State.FinishedAt,
                exitCode: row.State.ExitCode,
                pid: row.State.Pid ?? null,
                oomKilled: row.State.OOMKilled,
              })),
            );
          } catch {
            ownershipMatches = false;
            cleanupFailures.push('OWNED_STOP_UNCONFIRMED');
          }
        }
        // 실패 실행에서도 비밀 없는 부분 원자료만 별도로 복사한다. 원본 볼륨을 보존한다.
        if (!complete && allOwned.length) {
          try {
            const generator = ownedRows.find((row) => row.Config.Labels['com.docker.compose.service'] === 'generator');
            if (generator) {
              const partial = resolve(output, 'partial-artifacts');
              await mkdir(partial, { mode: 0o700 });
              await native(
                ['cp', `${generator.Id}:/evidence/.`, partial],
                'copy-partial-evidence',
                cleanup.signal,
                10_000,
              );
            }
          } catch {
            cleanupFailures.push('PARTIAL_COPY_FAILED');
          }
        }
        if (
          !values.keep &&
          mayDeleteOwnedData({
            succeeded: succeeded && cleanupFailures.length === 0,
            ownershipMatches,
            databaseOidMatches,
            databaseConnections: connections,
            commands: commands.receipts,
            pending: commands.pending.size,
            stickyUnsettled: commands.stickyUnsettled,
          })
        ) {
          await compose(['down', '-v'], 'delete-owned-project', cleanup.signal, 60_000);
          const remaining = await native(
            ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
            'post-delete-volume-catalog',
            cleanup.signal,
          );
          if (remaining.trim()) throw new Error('LOAD_OWNED_VOLUMES_REMAIN');
          deleted = true;
        }
      }
    } catch {
      cleanupFailures.push('CLEANUP_FAILED');
    } finally {
      clearTimeout(cleanupTimer);
      if (succeeded && (!ownershipMatches || !databaseOidMatches || connections !== 0))
        cleanupFailures.push('FINAL_SCOPE_OR_DATABASE_UNCONFIRMED');
      try {
        await writeEvidence(resolve(output, 'lifecycle.json'), {
          version: 1,
          project,
          databaseName,
          knownOid: knownOid ?? null,
          complete,
          performancePassed: succeeded,
          executionSucceeded:
            succeeded &&
            cleanupFailures.length === 0 &&
            commands.pending.size === 0 &&
            !commands.stickyUnsettled &&
            (deleted || values.keep === true),
          verdict: finalVerdict,
          sourceUnchanged,
          ownershipMatches,
          databaseOidMatches,
          connections,
          deleted,
          kept: values.keep,
          cleanupFailures,
          commands: commands.receipts,
          pending: commands.pending.size,
          stickyUnsettled: commands.stickyUnsettled,
        });
      } catch {
        cleanupFailures.push('LIFECYCLE_WRITE_FAILED');
      }
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      clearTimeout(hardTimer);
      clearTimeout(cleanupHardTimer);
    }
    if (
      cleanupFailures.length ||
      commands.pending.size ||
      commands.stickyUnsettled ||
      (!values.keep && succeeded && !deleted)
    )
      failures.push(new Error('LOAD_CLEANUP_UNCONFIRMED'));
  }
  if (failures.length) throw new AggregateError(failures, 'LOAD_EXECUTION_FAILED');
  process.stdout.write(`${finalVerdict}\n`);
  return succeeded ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch {
    process.stderr.write('LOAD_EXECUTION_FAILED\n');
    process.exitCode = 1;
  }
}
