import fs from 'node:fs';
import nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTROL = {
  test: (value) =>
    [...value].some((char) => {
      const code = char.codePointAt(0);
      return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
    }),
};
const B1_FILES = [
  'tools/backup.sh',
  'tools/restore.sh',
  'tools/.gitattributes',
  'tools/t2-15-month-child.ts',
  'tools/t2-15-backup-restore.test.ts',
  'tools/t2-15-restore.integration.test.ts',
];
const INSPECT =
  '{"Id":{{json .Id}},"Running":{{json .State.Running}},"Ports":{{json (index .NetworkSettings.Ports "5432/tcp")}}}';
const REASONS = new Set([
  'usage',
  'ambient-t215',
  'input-format',
  'credential-declaration',
  'existing-url-endpoint',
  'source-head',
  'source-dirty',
  'b1-files',
  'checkout-env',
  'docker-binary',
  'docker-socket',
  'runner-temp',
  'pnpm-store',
  'state-exists',
  'state-write',
  'owned-entry',
  'service-identity',
  'service-binding',
  'system-identifier',
  'secret-file',
  'github-env',
  'env-line',
  'internal',
]);

function fail(reason) {
  throw Object.assign(new Error(), { reason });
}

function within(parent, child, separator) {
  return child === parent || child.startsWith(`${parent}${separator}`);
}

function overlap(a, b, separator) {
  return within(a, b, separator) || within(b, a, separator);
}

/**
 * All platform effects are injectable; the CLI uses only Node built-ins.
 * @param {{mode?: string, path?: typeof nodePath, env?: NodeJS.ProcessEnv,
 * io?: typeof fs, spawn?: typeof spawnSync, uid?: number, nonce?: () => string,
 * stdout?: (line: string) => unknown, stderr?: (line: string) => unknown}} [options]
 */
export function runBinding({
  mode,
  path = nodePath,
  env = process.env,
  io = fs,
  spawn = spawnSync,
  uid = process.getuid?.(),
  nonce = () => randomBytes(16).toString('hex'),
  stdout = (line) => process.stdout.write(line),
  stderr = (line) => process.stderr.write(line),
} = {}) {
  let anchor;
  let madeAnchor = false;
  /** @type {{version: number, seq: number, run: string, attempt: string, job: string,
   * uid: number, nonce: string, anchor: {dev: string, ino: string}, stage: string,
   * entries: Record<string, {name: string, kind: string, mode: number, status: string, dev?: string, ino?: string}>}} */
  let state;
  const stat = (name) => io.lstatSync(name, { bigint: true });
  const maybe = (name) => {
    try {
      return stat(name);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const owned = (s, kind, permissions) =>
    !s.isSymbolicLink() &&
    Number(s.uid) === uid &&
    (kind === 'directory' ? s.isDirectory() : s.isFile()) &&
    (Number(s.mode) & 0o7777) === permissions;
  const identity = (s) => ({ dev: String(s.dev), ino: String(s.ino) });
  const sameIdentity = (s, recorded) => String(s.dev) === recorded.dev && String(s.ino) === recorded.ino;
  const checked = (reason, fn) => {
    try {
      return fn();
    } catch (error) {
      if (REASONS.has(error.reason)) throw error;
      fail(reason);
    }
  };
  const syncDirectory = (name) => {
    const fd = io.openSync(name, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);
    try {
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
  };
  const job = () => {
    if (
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(env.GITHUB_JOB ?? '') ||
      !Number.isSafeInteger(uid) ||
      uid < 0
    ) {
      fail('input-format');
    }
    return { run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB, uid };
  };
  const runnerTemp = () =>
    checked('runner-temp', () => {
      if (!path.isAbsolute(env.RUNNER_TEMP ?? '')) fail('runner-temp');
      const temp = io.realpathSync(env.RUNNER_TEMP);
      const s = stat(temp);
      if (!s.isDirectory() || s.isSymbolicLink() || Number(s.uid) !== uid) fail('runner-temp');
      return temp;
    });
  const commit = () =>
    checked('state-write', () => {
      const journal = path.join(anchor, 'state.json.next');
      const fd = io.openSync(journal, 'wx', 0o600);
      try {
        if (!owned(io.fstatSync(fd, { bigint: true }), 'file', 0o600)) fail('state-write');
        state.seq += 1;
        io.writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf8');
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      io.renameSync(journal, path.join(anchor, 'state.json'));
      syncDirectory(anchor);
    });
  const specs = (n) => ({
    scratch: { name: `t-${n}`, kind: 'directory', mode: 0o700 },
    secret: { name: `s-${n}`, kind: 'directory', mode: 0o700 },
    password: { name: `s-${n}/pg-password`, kind: 'file', mode: 0o600 },
    work: { name: `w-${n}`, kind: 'directory', mode: 0o700 },
  });
  const validateState = (value, anchorStat) => {
    if (
      !value ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.seq) ||
      value.seq < 1 ||
      !/^[0-9a-f]{32}$/.test(value.nonce ?? '') ||
      !['preparing', 'exported'].includes(value.stage) ||
      !value.entries ||
      typeof value.entries !== 'object' ||
      Array.isArray(value.entries) ||
      !value.anchor ||
      !/^\d+$/.test(value.anchor.dev ?? '') ||
      !/^\d+$/.test(value.anchor.ino ?? '')
    ) {
      return 'held-state-unrecoverable';
    }
    const current = job();
    if (Object.entries(current).some(([key, v]) => value[key] !== v) || !sameIdentity(anchorStat, value.anchor)) {
      return 'held-foreign-state';
    }
    const expected = specs(value.nonce);
    for (const [key, entry] of Object.entries(value.entries)) {
      const spec = Object.hasOwn(expected, key) ? expected[key] : undefined;
      if (
        !spec ||
        !entry ||
        Object.entries(spec).some(([k, v]) => entry[k] !== v) ||
        !(key === 'password' ? ['intent', 'empty', 'written'] : ['intent', 'created']).includes(entry.status) ||
        (entry.status === 'intent'
          ? entry.dev !== undefined || entry.ino !== undefined
          : !/^\d+$/.test(entry.dev ?? '') || !/^\d+$/.test(entry.ino ?? ''))
      ) {
        return 'held-state-unrecoverable';
      }
    }
    if (value.entries.password && value.entries.secret?.status !== 'created') return 'held-state-unrecoverable';
    return null;
  };
  const cleanup = () => {
    const results = new Set();
    const hold = (name) => results.add(name);
    anchor = path.join(runnerTemp(), 't215-binding');
    const a = maybe(anchor);
    if (!a) return ['nothing-prepared'];
    if (!owned(a, 'directory', 0o700)) return ['held-unproven-anchor'];
    const statePath = path.join(anchor, 'state.json');
    let saved;
    try {
      const s = maybe(statePath);
      if (!s) return ['held-unproven-anchor'];
      if (!owned(s, 'file', 0o600) || s.size > 65536n) return ['held-state-unrecoverable'];
      const fd = io.openSync(statePath, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
      try {
        const actual = io.fstatSync(fd, { bigint: true });
        if (!sameIdentity(actual, identity(s)) || !owned(actual, 'file', 0o600) || actual.size > 65536n) {
          return ['held-state-unrecoverable'];
        }
        saved = JSON.parse(io.readFileSync(fd, 'utf8'));
      } finally {
        io.closeSync(fd);
      }
    } catch {
      return ['held-state-unrecoverable'];
    }
    const invalid = validateState(saved, a);
    if (invalid) return [invalid];
    const journal = path.join(anchor, 'state.json.next');
    try {
      const s = maybe(journal);
      if (s) {
        if (owned(s, 'file', 0o600)) io.unlinkSync(journal);
        else hold('held-state-journal');
      }
    } catch {
      hold('held-state-journal');
    }
    const entryMatches = (entry, s, target) => {
      if (!owned(s, entry.kind, entry.mode)) return false;
      if (entry.status !== 'intent') return sameIdentity(s, entry);
      return entry.kind === 'file' ? s.size === 0n : io.readdirSync(target).length === 0;
    };
    const remove = (key, reason) => {
      const entry = saved.entries[key];
      if (!entry) return true;
      const target = path.join(anchor, entry.name);
      try {
        const s = maybe(target);
        if (!s) return true;
        if (!entryMatches(entry, s, target)) {
          hold('held-entry');
          hold(reason);
          return false;
        }
        if (entry.kind === 'file') io.unlinkSync(target);
        else io.rmdirSync(target);
        return true;
      } catch {
        hold(reason);
        return false;
      }
    };
    // Prove the parent before looking through it at the secret file.
    let secretProven = true;
    const secret = saved.entries.secret;
    if (secret) {
      try {
        const s = maybe(path.join(anchor, secret.name));
        if (s && !entryMatches(secret, s, path.join(anchor, secret.name))) secretProven = false;
      } catch {
        secretProven = false;
      }
    }
    if (secretProven) {
      remove('password', 'held-secret-file');
      remove('secret', 'held-secret-root');
    } else {
      hold('held-entry');
      hold('held-secret-file');
      hold('held-secret-root');
    }
    remove('scratch', 'held-scratch');
    const work = saved.entries.work;
    if (work) {
      const target = path.join(anchor, work.name);
      try {
        const s = maybe(target);
        if (s) {
          if (!entryMatches(work, s, target)) hold('held-entry');
          else if (maybe(path.join(target, 't215.lock'))) hold('held-b1-lock');
          else {
            try {
              io.rmdirSync(target);
            } catch (error) {
              if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') hold('work-root-retained');
              else hold('held-entry');
            }
          }
        }
      } catch {
        hold('held-entry');
      }
    }
    if (results.size === 0) {
      try {
        // Unknown entries cannot be deleted, and must not lose their ownership record.
        if (io.readdirSync(anchor).some((name) => name !== 'state.json')) return ['held-entry'];
        const current = stat(statePath);
        if (!owned(current, 'file', 0o600)) return ['held-state-unrecoverable'];
        io.unlinkSync(statePath);
        io.rmdirSync(anchor);
        results.add('cleaned');
      } catch {
        hold('held-unproven-anchor');
      }
    }
    return [...results];
  };
  const reportCleanup = () => {
    const statuses = cleanup();
    stdout(`t215-binding cleanup ${statuses.join(' ')}\n`);
    return statuses.some((value) => value.startsWith('held-')) ? 1 : 0;
  };
  const child = (binary, args, cwd, childEnv, reason, input = '') =>
    checked(reason, () => {
      if (maybe(path.join(cwd, '.env'))) fail('checkout-env');
      const result = spawn(binary, args, { cwd, env: childEnv, encoding: 'utf8', stdio: 'pipe', input });
      if (result.error || result.status !== 0 || result.signal) fail(reason);
      return result.stdout;
    });
  const createDirectory = (key) =>
    checked('owned-entry', () => {
      state.entries[key] = { ...specs(state.nonce)[key], status: 'intent' };
      commit();
      const target = path.join(anchor, state.entries[key].name);
      io.mkdirSync(target, { mode: 0o700 });
      const s = stat(target);
      if (!owned(s, 'directory', 0o700)) fail('owned-entry');
      syncDirectory(anchor);
      state.entries[key] = { ...state.entries[key], ...identity(s), status: 'created' };
      commit();
      return target;
    });
  try {
    if (mode !== 'prepare' && mode !== 'cleanup') fail('usage');
    job();
    if (mode === 'cleanup') return reportCleanup();
    if (Object.keys(env).some((key) => key.startsWith('T215_'))) fail('ambient-t215');
    if (
      !/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA ?? '') ||
      !/^[a-f0-9]{64}$/.test(env.BIND_PG_SERVICE_ID ?? '') ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(env.BIND_PG_ROLE ?? '') ||
      env.BIND_PG_ADMIN_DB !== 'postgres'
    ) {
      fail('input-format');
    }
    const password = checked('credential-declaration', () => {
      const urls = [env.DATABASE_URL, env.TEST_DATABASE_URL].map((value) => new URL(value));
      const credentials = urls.map((url) => ({
        user: decodeURIComponent(url.username),
        pass: decodeURIComponent(url.password),
      }));
      if (
        credentials.some((c) => c.user !== env.BIND_PG_ROLE || !c.pass || CONTROL.test(c.pass)) ||
        credentials[0].pass !== credentials[1].pass
      )
        fail('credential-declaration');
      if (
        urls.some(
          (url) =>
            !['postgres:', 'postgresql:'].includes(url.protocol) ||
            !['localhost', '127.0.0.1'].includes(url.hostname) ||
            url.port !== '5432',
        )
      )
        fail('existing-url-endpoint');
      return credentials[0].pass;
    });
    const checkout = checked('source-head', () => {
      if (!path.isAbsolute(env.GITHUB_WORKSPACE ?? '')) fail('source-head');
      return io.realpathSync(env.GITHUB_WORKSPACE);
    });
    const gitEnv = { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    if (
      child('/usr/bin/git', ['rev-parse', '--show-toplevel'], checkout, gitEnv, 'source-head').trim() !== checkout ||
      child('/usr/bin/git', ['rev-parse', 'HEAD'], checkout, gitEnv, 'source-head').trim() !== env.EXPECTED_SHA
    )
      fail('source-head');
    child('/usr/bin/git', ['diff', '--quiet'], checkout, gitEnv, 'source-dirty');
    child('/usr/bin/git', ['diff', '--cached', '--quiet'], checkout, gitEnv, 'source-dirty');
    child('/usr/bin/git', ['ls-files', '--error-unmatch', '--', ...B1_FILES], checkout, gitEnv, 'b1-files');
    checked('docker-binary', () => {
      const s = stat('/usr/bin/docker');
      if (!s.isFile() || s.isSymbolicLink() || Number(s.uid) !== 0 || Number(s.mode) & 0o022) fail('docker-binary');
      io.accessSync('/usr/bin/docker', io.constants.X_OK);
    });
    checked('docker-socket', () => {
      const s = io.statSync('/var/run/docker.sock', { bigint: true });
      if (!s.isSocket() || Number(s.uid) !== 0 || io.realpathSync('/var/run/docker.sock') !== '/run/docker.sock')
        fail('docker-socket');
      io.accessSync('/var/run/docker.sock', io.constants.R_OK | io.constants.W_OK);
    });
    const temp = runnerTemp();
    if (overlap(temp, checkout, path.sep)) fail('runner-temp');
    anchor = path.join(temp, 't215-binding');
    const store = checked('pnpm-store', () => {
      if (!path.isAbsolute(env.PNPM_HOME ?? '')) fail('pnpm-store');
      const candidate = path.join(env.PNPM_HOME, 'store');
      const s = stat(candidate);
      if (s.isSymbolicLink() || !s.isDirectory() || Number(s.uid) !== uid) fail('pnpm-store');
      const real = io.realpathSync(candidate);
      if (overlap(real, checkout, path.sep) || overlap(real, anchor, path.sep)) fail('pnpm-store');
      const files = path.join(real, 'v10', 'files');
      if (!stat(files).isDirectory()) fail('pnpm-store');
      const dir = io.opendirSync(files);
      try {
        if (!dir.readSync()) fail('pnpm-store');
      } finally {
        dir.closeSync();
      }
      return real;
    });
    checked('owned-entry', () => {
      try {
        io.mkdirSync(anchor, { mode: 0o700 });
      } catch (error) {
        if (error.code === 'EEXIST') fail('state-exists');
        throw error;
      }
      madeAnchor = true;
      const s = stat(anchor);
      if (!owned(s, 'directory', 0o700)) fail('owned-entry');
      const n = nonce();
      if (!/^[0-9a-f]{32}$/.test(n)) fail('internal');
      state = { version: 1, seq: 0, ...job(), nonce: n, anchor: identity(s), entries: {}, stage: 'preparing' };
      commit();
    });
    const scratch = createDirectory('scratch');
    const dockerEnv = {
      PATH: '/usr/bin:/bin',
      HOME: scratch,
      DOCKER_CONFIG: scratch,
      DOCKER_HOST: 'unix:///var/run/docker.sock',
    };
    const service = checked('service-identity', () =>
      JSON.parse(
        child(
          '/usr/bin/docker',
          ['inspect', '--type', 'container', '--format', INSPECT, env.BIND_PG_SERVICE_ID],
          scratch,
          dockerEnv,
          'service-identity',
        ),
      ),
    );
    if (!service || service.Id !== env.BIND_PG_SERVICE_ID || service.Running !== true) fail('service-identity');
    if (
      !Array.isArray(service.Ports) ||
      service.Ports.length !== 1 ||
      service.Ports[0]?.HostIp !== '127.0.0.1' ||
      service.Ports[0]?.HostPort !== '5432'
    )
      fail('service-binding');
    const sysid = child(
      '/usr/bin/docker',
      [
        'exec',
        '-i',
        env.BIND_PG_SERVICE_ID,
        'psql',
        '-X',
        '-At',
        '-w',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        env.BIND_PG_ROLE,
        '-d',
        'postgres',
      ],
      scratch,
      dockerEnv,
      'system-identifier',
      'SELECT system_identifier::text FROM pg_control_system();\n',
    );
    if (!/^\d{1,20}\n?$/.test(sysid)) fail('system-identifier');
    const secretRoot = createDirectory('secret');
    state.entries.password = { ...specs(state.nonce).password, status: 'intent' };
    commit();
    checked('secret-file', () => {
      const target = path.join(secretRoot, 'pg-password');
      const fd = io.openSync(target, 'wx', 0o600);
      try {
        syncDirectory(secretRoot);
        const s = io.fstatSync(fd, { bigint: true });
        if (!owned(s, 'file', 0o600) || s.size !== 0n) fail('secret-file');
        state.entries.password = { ...state.entries.password, ...identity(s), status: 'empty' };
        commit();
        io.writeFileSync(fd, `${password}\n`, 'utf8');
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
      const after = stat(target);
      if (
        !owned(after, 'file', 0o600) ||
        !sameIdentity(after, state.entries.password) ||
        after.size !== BigInt(Buffer.byteLength(`${password}\n`))
      )
        fail('secret-file');
      state.entries.password.status = 'written';
      commit();
    });
    const work = createDirectory('work');
    const values = {
      T215_PG_CONTAINER: service.Id,
      T215_PG_SYSTEM_IDENTIFIER: sysid.trim(),
      T215_PG_ENDPOINT: '127.0.0.1:5432',
      T215_PG_ROLE: env.BIND_PG_ROLE,
      T215_PG_ADMIN_DB: 'postgres',
      T215_PG_PASSWORD_FILE: path.join(secretRoot, 'pg-password'),
      T215_DOCKER: '/usr/bin/docker',
      T215_DOCKER_HOST: 'unix:///var/run/docker.sock',
      T215_PNPM_STORE: store,
      T215_WORK_ROOT: work,
    };
    if (Object.values(values).some((value) => CONTROL.test(value))) fail('env-line');
    stdout(`::add-mask::${state.nonce}\n`);
    checked('github-env', () => {
      if (!path.isAbsolute(env.GITHUB_ENV ?? '')) fail('github-env');
      const s = stat(env.GITHUB_ENV);
      if (!owned(s, 'file', Number(s.mode) & 0o7777)) fail('github-env');
      const real = io.realpathSync(env.GITHUB_ENV);
      if (real === temp || !within(temp, real, path.sep)) fail('github-env');
      const fd = io.openSync(env.GITHUB_ENV, io.constants.O_APPEND | io.constants.O_WRONLY | io.constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(io.fstatSync(fd, { bigint: true }), identity(s))) fail('github-env');
        io.writeFileSync(
          fd,
          Object.entries(values)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
          'utf8',
        );
      } finally {
        io.closeSync(fd);
      }
    });
    state.stage = 'exported';
    commit();
    stdout('t215-binding prepare ok\n');
    return 0;
  } catch (error) {
    if (mode === 'prepare' && madeAnchor) {
      try {
        reportCleanup();
      } catch {
        stdout('t215-binding cleanup held-state-unrecoverable\n');
      }
    }
    stderr(
      `t215-binding ${['prepare', 'cleanup'].includes(mode) ? mode : 'usage'} fail ${REASONS.has(error.reason) ? error.reason : 'internal'}\n`,
    );
    return 1;
  }
}

/** @param {string | undefined} entry @param {string} moduleFile @param {typeof fs} [io] */
export function isDirectExecution(entry, moduleFile, io = fs) {
  return Boolean(entry) && io.realpathSync(entry) === io.realpathSync(moduleFile);
}

let direct = false;
try {
  direct = isDirectExecution(process.argv[1], fileURLToPath(import.meta.url));
} catch {
  process.stderr.write('t215-binding usage fail internal\n');
  process.exitCode = 1;
}
if (direct) {
  const mode =
    process.argv.length === 3 && ['prepare', 'cleanup'].includes(process.argv[2]) ? process.argv[2] : 'usage';
  const internal = () => {
    process.stderr.write(`t215-binding ${mode} fail internal\n`);
    process.exitCode = 1;
  };
  process.on('uncaughtException', internal);
  process.on('unhandledRejection', internal);
  process.exitCode = runBinding({ mode: process.argv.length === 3 ? process.argv[2] : undefined });
}
