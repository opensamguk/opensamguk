import { mkdtemp, mkdir, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { OwnedChildScope } from './owned-child-scope';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => (resolve = accept));
  return { promise, resolve };
}

const script = `
process.stdout.write('ready\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => { process.exitCode = Number(input.trim()); });
`;
type Child = ReturnType<OwnedChildScope['start']>;
let sandbox: OwnedChildScope;
let inner: OwnedChildScope[];
let children: Child[];
beforeEach(() => {
  const ownSandbox = new OwnedChildScope({ label: 'sandbox' });
  const ownInner: OwnedChildScope[] = [];
  const ownChildren: Child[] = [];
  sandbox = ownSandbox;
  inner = ownInner;
  children = ownChildren;
  return async () => {
    for (const { child } of ownChildren) if (!child.stdin!.writableEnded) child.stdin!.end('0\n');
    await Promise.all(ownChildren.map(({ closed }) => closed));
    await Promise.all(ownInner.map((scope) => scope.close()));
    await ownSandbox.close();
  };
});

async function directory(scope = sandbox, parent = tmpdir()) {
  return scope.fixture(async (register) => {
    const root = await mkdtemp(join(parent, 'owned-child-test-'));
    await register(root, { parent, prefix: 'owned-child-test-' });
    return root;
  });
}
function scope(traceDir?: string) {
  const value = new OwnedChildScope({ label: 'regression', traceDir });
  inner.push(value);
  return value;
}
async function child(scope: OwnedChildScope, cwd: string, marker?: string) {
  const value = scope.start(process.execPath, ['-e', script], {
    cwd,
    windowsHide: true,
    env: { ...process.env, ...(marker ? { FIXTURE_SECRET: marker } : {}) },
  });
  children.push(value);
  const ready = new Promise<void>((accept) => {
    let output = '';
    value.child.stdout!.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.includes('ready\n')) accept();
    });
  });
  await ready;
  return value;
}
const readTrace = async (dir: string) => JSON.parse(await readFile(join(dir, (await readdir(dir))[0]!), 'utf8'));

describe('owned test child scopes', () => {
  it('waits for native close before deleting its fixture and persists the pending snapshot', async () => {
    const trace = await directory();
    const own = scope(trace);
    const root = await directory(own);
    const running = await child(own, root);
    const closing = own.close();
    await access(root);
    const pending = await readTrace(trace);
    expect(pending.state).toBe('closing');
    expect(pending.children[0].pid).toBe(running.child.pid);
    expect(pending.children[0].closedAt).toBeUndefined();
    running.child.stdin!.end('0\n');
    expect((await running.closed).code).toBe(0);
    await closing;
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
    const complete = await readTrace(trace);
    expect(complete.state).toBe('closed');
    expect(complete.removed[0].started).toBeGreaterThanOrEqual(complete.children[0].closedAt);
  });

  it('does not join or remove another scope when a previous case is still closing', async () => {
    const a = scope();
    const rootA = await directory(a);
    const childA = await child(a, rootA);
    const closingA = a.close();
    const b = scope();
    const rootB = await directory(b);
    const childB = await child(b, rootB);
    childB.child.stdin!.end('0\n');
    await b.close();
    await expect(access(rootB)).rejects.toMatchObject({ code: 'ENOENT' });
    await access(rootA);
    expect(a.snapshot().state).toBe('closing');
    childA.child.stdin!.end('0\n');
    await closingA;
  });

  it('rejects new spawns and fixture creation once closing starts', async () => {
    const own = scope();
    const root = await directory(own);
    const running = await child(own, root);
    const closing = own.close();
    expect(() => own.start(process.execPath, ['-e', script], {})).toThrow('CHILD_SCOPE_CLOSING');
    let called = false;
    expect(() => own.fixture(async () => (called = true))).toThrow('CHILD_SCOPE_CLOSING');
    expect(called).toBe(false);
    running.child.stdin!.end('0\n');
    await closing;
  });

  it('retains a late admitted directory in its original closing scope', async () => {
    const own = scope();
    const trace = await directory();
    const gate = deferred<void>();
    const creating = own.fixture(async (register) => {
      await gate.promise;
      const root = await mkdtemp(join(trace, 'owned-child-test-'));
      await register(root, { parent: trace, prefix: 'owned-child-test-' });
      return root;
    });
    const closing = own.close();
    expect(own.snapshot().state).toBe('closing');
    gate.resolve();
    const root = await creating;
    await closing;
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(own.snapshot().removed).toHaveLength(1);
  });

  it('joins a nonzero normal exit without replacing its result', async () => {
    const own = scope();
    const root = await directory(own);
    const running = await child(own, root);
    running.child.stdin!.end('3\n');
    expect(await running.closed).toMatchObject({ code: 3, signal: null });
    await own.close();
    expect(own.snapshot().children[0]).toMatchObject({ code: 3, signal: null });
  });

  it('records hashes and timing without environment, script, or output content', async () => {
    const trace = await directory();
    const own = scope(trace);
    const root = await directory(own);
    const marker = 'synthetic-private-marker-762';
    const secretScript = script.replace(
      "process.stdout.write('ready\\n');",
      `process.stdout.write('ready\\n' + process.env.FIXTURE_SECRET);`,
    );
    const running = own.start(process.execPath, ['-e', secretScript, root], {
      cwd: root,
      env: { ...process.env, FIXTURE_SECRET: marker },
      windowsHide: true,
    });
    children.push(running);
    await new Promise<void>((accept) => running.child.stdout!.once('data', () => accept()));
    running.child.stdin!.end('0\n');
    await own.close();
    const report = await readTrace(trace);
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(report.children[0].argv).toEqual(['-e', '<inline-script>', '<root>']);
    expect(report.children[0].stdoutBytes).toBeGreaterThan(6);
    expect(report.children[0].stdoutSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.children[0].firstStdoutAt).toBeGreaterThanOrEqual(report.children[0].spawnedAt);
  });

  it('writes nothing without an injected trace directory and rejects invalid destinations', async () => {
    const parent = await directory();
    const own = scope();
    const root = await directory(own, parent);
    const running = await child(own, root);
    running.child.stdin!.end('0\n');
    await own.close();
    expect(await readdir(parent)).toEqual([]);
    expect(() => new OwnedChildScope({ label: 'regression', traceDir: 'relative-trace' })).toThrow(
      'CHILD_TRACE_DIRECTORY',
    );
    const missing = join(parent, 'missing');
    expect(() => new OwnedChildScope({ label: 'regression', traceDir: missing })).toThrow('CHILD_TRACE_DIRECTORY');
    await mkdir(join(parent, 'empty'));
  });
});
