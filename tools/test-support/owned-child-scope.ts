import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

type DirectoryOwner = { parent: string; prefix: string };
type OwnedDirectory = DirectoryOwner & { path: string; real: string; realParent: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export class OwnedChildScope {
  private readonly started = performance.now();
  private readonly id = randomUUID();
  private readonly roots: OwnedDirectory[] = [];
  private readonly creations: Promise<unknown>[] = [];
  private readonly children: { closed: Promise<Exit>; record: Record<string, unknown>; output: () => object }[] = [];
  private readonly removed: { root: string; started: number; finished: number }[] = [];
  private readonly traceFile: string | undefined;
  private state = 'open';
  private closingAt: number | undefined;
  private finishedAt: number | undefined;
  private failure: string | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: { label: string; traceDir?: string | undefined; repoRoot?: string }) {
    if (options.traceDir !== undefined) {
      if (!isAbsolute(options.traceDir)) throw new Error('CHILD_TRACE_DIRECTORY');
      try {
        if (!lstatSync(options.traceDir).isDirectory()) throw new Error('CHILD_TRACE_DIRECTORY');
        this.traceFile = join(realpathSync(options.traceDir), `${process.pid}-${this.id}.json`);
      } catch {
        throw new Error('CHILD_TRACE_DIRECTORY');
      }
    }
  }

  private elapsed() {
    return performance.now() - this.started;
  }

  private assertOpen() {
    if (this.state !== 'open') throw new Error('CHILD_SCOPE_CLOSING');
  }

  private mask(value: string) {
    const normalized = value.replaceAll('\\', '/');
    const locations: readonly (readonly [string, string])[] = [
      ...this.roots.map((root) => [root.path, '<root>'] as const),
      [this.options.repoRoot ?? process.cwd(), '<repo>'],
      [tmpdir(), '<tmp>'],
    ];
    for (const [location, label] of locations) {
      const prefix = resolve(location).replaceAll('\\', '/');
      if (samePath(normalized, prefix)) return label;
      if (samePath(normalized.slice(0, prefix.length + 1), `${prefix}/`))
        return label + normalized.slice(prefix.length);
    }
    return undefined;
  }

  snapshot() {
    return {
      id: this.id,
      label: this.options.label,
      state: this.state,
      closingAt: this.closingAt,
      finishedAt: this.finishedAt,
      failure: this.failure,
      roots: this.roots.map(() => '<root>'),
      children: this.children.map(({ record, output }) => ({ ...record, ...output() })),
      removed: [...this.removed],
    };
  }

  private checkpoint() {
    if (this.traceFile) writeFileSync(this.traceFile, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }

  fixture<T>(
    create: (register: (directory: string, owner: DirectoryOwner) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const creation = Promise.resolve().then(() =>
      create(async (directory, owner) => {
        const path = resolve(directory);
        const actual = await lstat(path);
        const real = await realpath(path);
        const realParent = await realpath(owner.parent);
        if (
          !actual.isDirectory() ||
          actual.isSymbolicLink() ||
          !basename(path).startsWith(owner.prefix) ||
          !samePath(dirname(real), realParent)
        )
          throw new Error('CHILD_SCOPE_DIRECTORY');
        this.roots.push({ ...owner, path, real, realParent });
      }),
    );
    this.creations.push(creation);
    return creation;
  }

  start(command: string, args: string[], options: SpawnOptions) {
    this.assertOpen();
    const record: Record<string, unknown> = {
      command: basename(command),
      argv: args.map((arg, index) => {
        if (index > 0 && args[index - 1] === '-e') return '<inline-script>';
        return (
          this.mask(arg) ??
          (/^--?[a-z-]+$/i.test(arg) || ['tsx', 'validate', 'probe', 'tools/participation/cli.ts'].includes(arg)
            ? arg
            : '<value>')
        );
      }),
      cwd: this.mask(String(options.cwd ?? process.cwd())) ?? '<cwd>',
      startedAt: this.elapsed(),
    };
    const stdout = createHash('sha256');
    const stderr = createHash('sha256');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    const child = spawn(command, args, options);
    record.pid = child.pid;
    child.once('spawn', () => (record.spawnedAt = this.elapsed()));
    child.stdout?.on('data', (chunk: Buffer | string) => {
      record.firstStdoutAt ??= this.elapsed();
      stdoutBytes += Buffer.byteLength(chunk);
      stdout.update(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      record.firstStderrAt ??= this.elapsed();
      stderrBytes += Buffer.byteLength(chunk);
      stderr.update(chunk);
    });
    child.once('error', (caught: NodeJS.ErrnoException) => {
      error = caught;
      record.errorCode = /^[A-Z0-9_]+$/.test(caught.code ?? '') ? caught.code : 'CHILD_ERROR';
    });
    child.once('exit', (code, signal) => {
      record.exitedAt = this.elapsed();
      record.code = code;
      record.signal = signal;
    });
    const closed = new Promise<Exit>((accept) => {
      child.once('close', (code, signal) => {
        record.closedAt = this.elapsed();
        record.code = code;
        record.signal = signal;
        accept({ code, signal, ...(error ? { error } : {}) });
      });
    });
    this.children.push({
      closed,
      record,
      output: () => ({
        stdoutBytes,
        stderrBytes,
        stdoutSha256: stdout.copy().digest('hex'),
        stderrSha256: stderr.copy().digest('hex'),
      }),
    });
    return { child, closed };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = 'closing';
    this.closingAt = this.elapsed();
    this.closing = this.finish();
    return this.closing;
  }

  private async finish() {
    try {
      this.checkpoint();
      await Promise.allSettled(this.creations);
      await Promise.all(this.children.map(({ closed }) => closed));
      for (const root of [...this.roots].reverse()) {
        const actual = await lstat(root.path);
        if (
          !samePath(resolve(root.path), root.path) ||
          !actual.isDirectory() ||
          actual.isSymbolicLink() ||
          !samePath(await realpath(root.path), root.real) ||
          !samePath(await realpath(root.parent), root.realParent) ||
          !samePath(dirname(root.real), root.realParent) ||
          !basename(root.path).startsWith(root.prefix)
        )
          throw new Error('CHILD_SCOPE_DIRECTORY');
        const started = this.elapsed();
        await rm(root.path, { recursive: true, force: true });
        this.removed.push({ root: '<root>', started, finished: this.elapsed() });
      }
      this.state = 'closed';
    } catch (caught) {
      this.state = 'failed';
      this.failure =
        caught instanceof Error && caught.message === 'CHILD_SCOPE_DIRECTORY' ? caught.message : 'CHILD_SCOPE_CLEANUP';
      throw caught;
    } finally {
      this.finishedAt = this.elapsed();
      this.checkpoint();
    }
  }
}
