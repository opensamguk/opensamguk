import { pathToFileURL } from 'node:url';
import { posix, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLease, LEASE_TTL_MS, LeaseLostError, releaseLease, renewLease } from '../apps/engine/src/lease';
import { onShutdownRequest } from '../apps/engine/src/process-lifecycle';

export function rehearsalStoragePath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[eE]:[\\/]/.test(value) && win32.isAbsolute(value) : posix.isAbsolute(value);
}

type ArchiveReason =
  | 'archive-header'
  | 'archive-size'
  | 'archive-end'
  | 'archive-type'
  | 'archive-path'
  | 'archive-duplicate'
  | 'archive-conflict'
  | 'archive-link-target'
  | 'archive-link-missing'
  | 'archive-link-kind'
  | 'archive-link-chain'
  | 'archive-tracked-kind'
  | 'archive-denominator';

export class RehearsalArchiveError extends Error {
  constructor(reason: ArchiveReason) {
    super(reason);
    this.name = 'RehearsalArchiveError';
  }
}

type ArchiveEntry =
  | { path: string; kind: 'directory' }
  | { path: string; kind: 'regular'; data: Buffer }
  | { path: string; kind: 'link'; target: string; tarMode: string };

type RehearsalArchivePlan = {
  directories: string[];
  files: { path: string; data: Buffer; source: 'regular' | 'link'; linkTarget?: string }[];
  links: { name: string; target: string; resolved: string; tarMode: string }[];
  counts: { regular: number; link: number; directory: number; globalPax: number; headers: number };
};

// Git ustar 전체를 먼저 검증한다. 실제 링크와 디스크 대상 조회는 쓰지 않는다.
export function readRehearsalArchive(data: Buffer): RehearsalArchivePlan {
  function reject(reason: ArchiveReason): never {
    throw new RehearsalArchiveError(reason);
  }
  const entries = new Map<string, ArchiveEntry>();
  const names = new Set<string>();
  const counts = { regular: 0, link: 0, directory: 0, globalPax: 0, headers: 0 };
  const invalidCharacters = (value: string) =>
    /[\\:]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  let ended = false;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    const field = (start: number, size: number) =>
      header
        .subarray(start, start + size)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const octal = (start: number, size: number, reason: ArchiveReason) => {
      const value = field(start, size).trim();
      if (!/^[0-7]+$/.test(value)) return reject(reason);
      const number = Number.parseInt(value, 8);
      if (!Number.isSafeInteger(number) || number < 0) return reject(reason);
      return number;
    };
    if (field(257, 6) !== 'ustar') reject('archive-header');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (octal(148, 8, 'archive-header') !== checksum) reject('archive-header');
    const size = octal(124, 12, 'archive-size');
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > data.length) reject('archive-size');
    const type = field(156, 1);
    if (!['0', '', '2', '5', 'g'].includes(type)) reject('archive-type');
    if ((type === '2' || type === '5') && size !== 0) reject('archive-size');
    if (!field(0, 100)) reject('archive-path');
    let name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    if (type === '5' && name.endsWith('/')) name = name.slice(0, -1);
    if (
      !name ||
      posix.isAbsolute(name) ||
      win32.isAbsolute(name) ||
      invalidCharacters(name) ||
      name.split('/').some((part) => part === '' || part === '.' || part === '..')
    )
      reject('archive-path');
    if (names.has(name)) reject('archive-duplicate');
    names.add(name);
    counts.headers++;
    if (type === 'g') counts.globalPax++;
    else if (type === '5') {
      entries.set(name, { path: name, kind: 'directory' });
      counts.directory++;
    } else if (type === '2') {
      entries.set(name, { path: name, kind: 'link', target: field(157, 100), tarMode: field(100, 8).trim() });
      counts.link++;
    } else {
      entries.set(name, { path: name, kind: 'regular', data: data.subarray(offset + 512, offset + 512 + size) });
      counts.regular++;
    }
    offset = next;
  }
  if (!ended) reject('archive-end');
  for (const entry of entries.values()) {
    for (let parent = posix.dirname(entry.path); parent !== '.'; parent = posix.dirname(parent)) {
      const found = entries.get(parent);
      if (found && found.kind !== 'directory') reject('archive-conflict');
    }
  }
  const files: RehearsalArchivePlan['files'] = [];
  const directories: string[] = [];
  const links: RehearsalArchivePlan['links'] = [];
  for (const entry of entries.values()) {
    if (entry.kind === 'directory') directories.push(entry.path);
    else if (entry.kind === 'regular') files.push({ path: entry.path, data: entry.data, source: 'regular' });
  }
  for (const entry of entries.values()) {
    if (entry.kind !== 'link') continue;
    const target = entry.target;
    if (!target || posix.isAbsolute(target) || win32.isAbsolute(target) || invalidCharacters(target))
      reject('archive-link-target');
    const resolved = posix.normalize(posix.join(posix.dirname(entry.path), target));
    if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) reject('archive-link-target');
    const found = entries.get(resolved);
    if (!found) reject('archive-link-missing');
    if (found.kind === 'directory') reject('archive-link-kind');
    if (found.kind === 'link') reject('archive-link-chain');
    files.push({ path: entry.path, data: found.data, source: 'link', linkTarget: target });
    links.push({ name: entry.path, target, resolved, tarMode: entry.tarMode });
  }
  return { directories, files, links, counts };
}

// ls-tree의 추적 regular·link 집합을 모두 대조한다. export-ignore로 분모를 줄이지 않는다.
export function checkRehearsalArchiveTree(lsTree: Buffer, plan: RehearsalArchivePlan): void {
  const expected = new Map(plan.files.map((file) => [file.path, file.source]));
  const linkNames = new Set(plan.links.map((link) => link.name));
  const seen = new Set<string>();
  const text = lsTree.toString('utf8');
  if (text && !text.endsWith('\0')) throw new RehearsalArchiveError('archive-tracked-kind');
  for (const row of text.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const header = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40})$/.exec(row.slice(0, tab));
    if (tab < 0 || !header || header[2] !== 'blob' || !['100644', '100755', '120000'].includes(header[1]!))
      throw new RehearsalArchiveError('archive-tracked-kind');
    const name = row.slice(tab + 1);
    const link = header[1] === '120000';
    if (seen.has(name) || expected.get(name) !== (link ? 'link' : 'regular') || linkNames.has(name) !== link)
      throw new RehearsalArchiveError('archive-denominator');
    seen.add(name);
  }
  if (seen.size !== expected.size) throw new RehearsalArchiveError('archive-denominator');
}

export type RehearsalStageRecord = {
  name: string;
  status: 'passed' | 'failed';
  elapsedMs: number;
  reason?: string;
};

// B1의 자기 기한은 vitest hook·case의 30초보다 짧다. 늦은 작업도 정리까지 소유한다.
export function createRehearsalStages(
  controller: AbortController,
  record: (row: RehearsalStageRecord) => void,
  options: { budgetMs?: number; now?: () => number; reasonOf?: (error: unknown) => string } = {},
) {
  const budgetMs = options.budgetMs ?? 20_000;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 20_000) throw new Error('stage-budget');
  const now = options.now ?? (() => performance.now());
  const active = new Set<Promise<void>>();
  let failure: string | undefined;
  const reportFailure = (name: string, started: number) => {
    record({ name, status: 'failed', reason: failure!, elapsedMs: Math.max(0, now() - started) });
    return new Error(failure);
  };
  return {
    get activeCount() {
      return active.size;
    },
    get failure() {
      return failure;
    },
    async run(name: string, action: () => Promise<void>) {
      const started = now();
      if (failure) throw reportFailure(name, started);
      if (controller.signal.aborted) failure = 'aborted';
      else if (active.size) failure = 'previous-stage-active';
      if (failure) {
        controller.abort();
        throw reportFailure(name, started);
      }
      const operation = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        await action();
        controller.signal.throwIfAborted();
      });
      active.add(operation);
      // 두 결과를 모두 처리해 기한 뒤 reject도 미처리 promise로 버려 두지 않는다.
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let aborted: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        aborted = () => {
          failure ??= 'aborted';
          reject(new Error(failure));
        };
        controller.signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => {
          failure ??= 'stage-deadline';
          controller.abort();
        }, budgetMs);
      });
      try {
        await Promise.race([operation, stopped]);
        if (now() - started >= budgetMs) {
          failure ??= 'stage-deadline';
          controller.abort();
          throw new Error(failure);
        }
        if (failure || controller.signal.aborted) {
          failure ??= 'aborted';
          throw new Error(failure);
        }
        record({ name, status: 'passed', elapsedMs: Math.max(0, now() - started) });
      } catch (error) {
        failure ??= options.reasonOf?.(error) ?? 'operation-failed';
        controller.abort();
        throw reportFailure(name, started);
      } finally {
        clearTimeout(timer);
        if (aborted) controller.signal.removeEventListener('abort', aborted);
      }
    },
    async settle() {
      controller.abort();
      await Promise.allSettled([...active]);
    },
  };
}

// T2-15/AC-M2-09: 시험 부모와 month 자식이 같은 리스 수명주기를 쓴다.
export async function advanceWithLease(
  databaseUrl: string,
  worldId: string,
  target: number,
  signal: AbortSignal,
): Promise<{ renewals: number; reached: number }> {
  const endpoint = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
    !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
    (endpoint.port || '5432') === '5433' ||
    !/^t215_(?:src|dst)_[0-9a-f]{32}_test$/.test(endpoint.pathname.slice(1))
  )
    throw new Error('database');
  const [{ createDb }, { TurnLoop }] = await Promise.all([
    import('../packages/db/src/index'),
    import('../apps/engine/src/turnLoop'),
  ]);
  const db = createDb(databaseUrl);
  const session = new AbortController();
  const abort = () => session.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let renewal: Promise<void> | undefined;
  let renewalError: unknown;
  let renewals = 0;
  try {
    session.signal.throwIfAborted();
    lease = await acquireLease(db, worldId);
    if (!lease) throw new LeaseLostError();
    await renewLease(db, lease);
    renewals++;
    const owned = lease;
    renewal = (async () => {
      while (!session.signal.aborted) {
        try {
          await delay(LEASE_TTL_MS / 3, undefined, { signal: session.signal });
        } catch {
          break;
        }
        if (session.signal.aborted) break;
        try {
          await renewLease(db, owned);
          renewals++;
        } catch (error) {
          renewalError = error;
          session.abort();
        }
      }
    })();
    await new TurnLoop(db, lease).advanceTo(target, session.signal);
    if (renewalError) throw renewalError;
    session.signal.throwIfAborted();
    session.abort();
    await renewal;
    if (renewalError) throw renewalError;
    signal.throwIfAborted();
    const world = await db.world.findUniqueOrThrow({ where: { id: worldId }, select: { monthlyTick: true } });
    if (world.monthlyTick !== target) throw new Error('boundary');
    return { renewals, reached: world.monthlyTick };
  } finally {
    session.abort();
    await renewal;
    signal.removeEventListener('abort', abort);
    try {
      if (lease) await releaseLease(db, lease);
    } finally {
      await db.$disconnect();
    }
  }
}

async function main() {
  const abort = new AbortController();
  const off = onShutdownRequest(() => abort.abort());
  let status: string;
  try {
    const [worldId, boundary, ...extra] = process.argv.slice(2);
    const target = Number(boundary);
    if (!worldId || !boundary || extra.length || !Number.isSafeInteger(target) || target < 1) throw new Error('input');
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      (url.port || '5432') === '5433' ||
      !/^t215_dst_[0-9a-f]{32}_test$/.test(url.pathname.slice(1))
    )
      throw new Error('database');
    await advanceWithLease(url.href, worldId, target, abort.signal);
    status = 'ok';
  } catch (error) {
    status = error instanceof LeaseLostError ? 'lease-lost' : abort.signal.aborted ? 'aborted' : 'failed';
  } finally {
    off();
  }
  console.log(status);
  if (status !== 'ok') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
