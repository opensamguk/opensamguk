import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  acknowledge,
  observe,
  recordAttemptFailure,
  restoreState,
  serializeState,
  type Observation,
  type StateWarning,
  type UptimeState,
} from './uptimeState';
import { gitProcess, UptimeGitError, type GitProcessOptions } from './uptimeGitProcess';
import { validateUptimeToken, writeUptimeAuthConfig } from './uptimeGitAuth';

export const UPTIME_REF = 'refs/heads/ops/uptime-state';
type Operation =
  { kind: 'observe'; observation: Observation } | { kind: 'ack' | 'attemptFailure'; id: string; now: number };
export interface UptimeGitInput {
  remote: string;
  stateRef: string;
  key: string;
  operation: Operation;
}
export interface UptimeGitDependencies {
  /** 운영 호출의 명시한 HTTPS 인증. URL·인자·상속 환경에는 넣지 않는다. */
  httpsToken?: string;
  /** 시험 생성자 전용이다. CLI·환경·HTTP 설정으로 연결하지 않는다. */
  localRemote?: string;
  process?: Pick<GitProcessOptions, 'timeoutMs' | 'graceMs' | 'command' | 'onSpawn'>;
  beforeRead?: (attempt: number) => Promise<void>;
  beforePush?: (attempt: number) => Promise<void>;
  afterPush?: (attempt: number) => Promise<void>;
  onCommand?: (name: string) => void;
  onDirectory?: (directory: string) => void;
}
function check(value: unknown): asserts value {
  if (!value) throw new UptimeGitError('configuration');
}
const controls = (value: string, spaces = false) =>
  [...value].some((character) => character.charCodeAt(0) < (spaces ? 33 : 32) || character.charCodeAt(0) === 127);
function validate(input: UptimeGitInput, dependencies: UptimeGitDependencies) {
  if (dependencies.httpsToken !== undefined) {
    validateUptimeToken(dependencies.httpsToken);
    check(dependencies.localRemote === undefined);
  }
  check(input.stateRef === UPTIME_REF);
  check(input.key === 'prod' || /^drill-[A-Za-z0-9_-]{1,64}$/.test(input.key));
  let remote: URL;
  try {
    remote = new URL(input.remote);
  } catch {
    throw new UptimeGitError('configuration');
  }
  check(remote.protocol === 'https:' && !remote.username && !remote.password && !remote.search && !remote.hash);
  check(
    input.remote.startsWith('https://') &&
      !/[\\?#]/.test(input.remote) &&
      !controls(input.remote, true) &&
      remote.hostname &&
      remote.pathname !== '/',
  );
  if (dependencies.localRemote !== undefined)
    check(isAbsolute(dependencies.localRemote) && !controls(dependencies.localRemote));
  const operation = input.operation;
  check(operation && ['observe', 'ack', 'attemptFailure'].includes(operation.kind));
  const now = operation.kind === 'observe' ? operation.observation.now : operation.now;
  check(Number.isSafeInteger(now) && Number.isFinite(new Date(now).getTime()));
  if (operation.kind === 'observe') {
    check(operation.observation.key === input.key);
    check(typeof operation.observation.runId === 'string' && typeof operation.observation.runAttempt === 'string');
    check(/^[1-9][0-9]*$/.test(operation.observation.runId) && /^[1-9][0-9]*$/.test(operation.observation.runAttempt));
    check(
      typeof operation.observation.ok === 'boolean' && typeof operation.observation.webhookConfigured === 'boolean',
    );
  } else check(typeof operation.id === 'string' && operation.id.startsWith(input.key + ':'));
  return now;
}

export async function updateUptimeGit(input: UptimeGitInput, dependencies: UptimeGitDependencies = {}) {
  const now = validate(input, dependencies);
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-uptime-git-'));
  const parent = resolve(tmpdir()),
    rel = relative(parent, resolve(directory));
  check(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  let unsafe = false,
    failure: unknown;
  const remote = dependencies.localRemote ?? input.remote,
    path = `uptime/${input.key}.json`;
  const inherited: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    'PATH',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'LANGUAGE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
  ]);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase())) inherited[key] = value;
  const configuration = join(directory, 'gitconfig');
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    GIT_CONFIG_GLOBAL: configuration,
    GIT_CONFIG_SYSTEM: configuration,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_INDEX_FILE: join(directory, 'state.index'),
    GIT_AUTHOR_NAME: 'opensamguk uptime',
    GIT_AUTHOR_EMAIL: 'uptime@opensamguk.invalid',
    GIT_COMMITTER_NAME: 'opensamguk uptime',
    GIT_COMMITTER_EMAIL: 'uptime@opensamguk.invalid',
  };
  async function git(args: string[], data?: string) {
    try {
      dependencies.onCommand?.(args[0]!);
      return await gitProcess(
        [
          '-c',
          'protocol.allow=never',
          '-c',
          `protocol.${dependencies.localRemote === undefined ? 'https' : 'file'}.allow=always`,
          '-c',
          'http.followRedirects=false',
          '-c',
          'http.sslVerify=true',
          ...args,
        ],
        { ...dependencies.process, cwd: directory, env, ...(data === undefined ? {} : { input: data }) },
      );
    } catch (error) {
      if (error instanceof UptimeGitError) {
        unsafe ||= !error.cleanupSafe;
        throw error;
      }
      throw new UptimeGitError('command');
    }
  }
  async function required(args: string[], data?: string) {
    const result = await git(args, data);
    if (result.code !== 0) throw new UptimeGitError('read');
    return result.stdout.trimEnd();
  }
  async function read(attempt: number) {
    try {
      await dependencies.beforeRead?.(attempt);
    } catch {
      throw new UptimeGitError('read');
    }
    const listing = await git(['ls-remote', '--exit-code', '--refs', remote, input.stateRef]);
    if (listing.code === 2 && listing.stdout === '') return { head: null, raw: null };
    if (listing.code !== 0 || !new RegExp(`^[a-f0-9]{40}\\t${UPTIME_REF}\\n?$`).test(listing.stdout))
      throw new UptimeGitError('read');
    await required(['fetch', '--no-tags', remote, input.stateRef]);
    const head = await required(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    check(/^[a-f0-9]{40}$/.test(head));
    const entry = await required(['ls-tree', '-z', head, '--', path]);
    if (entry === '') return { head, raw: null };
    const match = /^100644 blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
    if (!match || match[2] !== path) throw new UptimeGitError('read');
    const blob = await git(['cat-file', 'blob', match[1]!]);
    if (blob.code !== 0) throw new UptimeGitError('read');
    return { head, raw: blob.stdout };
  }
  async function work() {
    dependencies.onDirectory?.(directory);
    if (dependencies.httpsToken === undefined) await writeFile(configuration, '', { flag: 'wx', mode: 0o600 });
    else await writeUptimeAuthConfig(directory, input.remote, dependencies.httpsToken);
    await required(['init', '--quiet', '.']);
    type Dropped = ReturnType<typeof observe>['dropped'][number];
    const candidates = new Map<string, { dropped: Dropped[]; warnings: StateWarning[] }>();
    async function confirmedMetadata(head: string | null, restoredWarnings: StateWarning[]) {
      const confirmed = new Map<string, Dropped>();
      const warnings = new Map(restoredWarnings.map((item) => [item.code + '\0' + (item.field ?? ''), item]));
      if (head)
        for (const [candidate, metadata] of candidates) {
          if (candidate !== head) {
            const ancestor = await git(['merge-base', '--is-ancestor', candidate, head]);
            if (ancestor.code === 1) continue;
            if (ancestor.code !== 0) throw new UptimeGitError('read');
          }
          for (const item of metadata.dropped) confirmed.set(item.reason + '\0' + item.id, item);
          for (const item of metadata.warnings) warnings.set(item.code + '\0' + (item.field ?? ''), item);
        }
      return { dropped: [...confirmed.values()], warnings: [...warnings.values()] };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await read(attempt);
      const restored = restoreState({ key: input.key, raw: snapshot.raw, now });
      if ('error' in restored) throw new UptimeGitError('state');
      let state: UptimeState, result: string, changed: boolean;
      let decision: 'down' | 'recovery' | null = null;
      let dropped: Dropped[] = [];
      if (input.operation.kind === 'observe') {
        const observation = observe(restored.state, input.operation.observation);
        state = observation.state;
        result = observation.result;
        changed = observation.result === 'applied';
        dropped = observation.dropped;
        decision =
          observation.added[0]?.kind ??
          (observation.suppressed === 'no_webhook' ? (state.alerting ? 'down' : 'recovery') : null);
      } else {
        const operation = input.operation;
        const update =
          operation.kind === 'ack'
            ? acknowledge(restored.state, operation)
            : recordAttemptFailure(restored.state, operation);
        state = update.state;
        result = update.result;
        changed = result === 'removed' || result === 'recorded';
      }
      if (result === 'clock_regressed' || result === 'not_head') throw new UptimeGitError('state');
      if (!changed)
        return {
          state,
          result,
          head: snapshot.head,
          committed: false,
          decision,
          attempts: attempt + 1,
          ...(await confirmedMetadata(snapshot.head, restored.warnings)),
        };
      await required(snapshot.head ? ['read-tree', snapshot.head] : ['read-tree', '--empty']);
      const blob = await required(['hash-object', '-w', '--stdin'], serializeState(state));
      check(/^[a-f0-9]{40}$/.test(blob));
      await required(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
      const tree = await required(['write-tree']);
      check(/^[a-f0-9]{40}$/.test(tree));
      const head = await required([
        'commit-tree',
        '--no-gpg-sign',
        tree,
        ...(snapshot.head ? ['-p', snapshot.head] : []),
        '-m',
        `uptime ${input.key} ${input.operation.kind}`,
      ]);
      check(/^[a-f0-9]{40}$/.test(head));
      if (dropped.length || restored.warnings.length) candidates.set(head, { dropped, warnings: restored.warnings });
      try {
        await dependencies.beforePush?.(attempt);
        const pushed = await git(['push', '--porcelain', remote, `${head}:${input.stateRef}`]);
        if (pushed.code !== 0) continue;
        await dependencies.afterPush?.(attempt);
        return {
          state,
          result,
          head,
          committed: true,
          decision,
          attempts: attempt + 1,
          ...(await confirmedMetadata(head, restored.warnings)),
        };
      } catch (error) {
        if (error instanceof UptimeGitError && error.kind === 'read') throw error;
        if (error instanceof UptimeGitError && !error.cleanupSafe) throw error;
        // 결과가 불명확한 push는 다시 읽은 상태에서 같은 입력으로 계산한다.
      }
    }
    throw new UptimeGitError('push');
  }
  let value: Awaited<ReturnType<typeof work>> | undefined;
  try {
    value = await work();
  } catch (error) {
    failure = error instanceof UptimeGitError ? error : new UptimeGitError('state');
    if (failure instanceof UptimeGitError) unsafe ||= !failure.cleanupSafe;
  }
  let cleanupFailure: UptimeGitError | undefined;
  if (!unsafe) {
    try {
      await rm(directory, { recursive: true });
    } catch {
      cleanupFailure = new UptimeGitError('cleanup');
    }
  }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], '가동 확인 Git 작업과 정리 실패.');
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return value!;
}
