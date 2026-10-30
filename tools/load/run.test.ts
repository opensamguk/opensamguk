import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { composeBudget } from './admission';
import { LOAD_DOCKER } from './docker';
import {
  assertContainerLimits,
  assertContainerOwnership,
  partitionOwnedContainers,
  renderLoadCompose,
  requireImageSource,
  verifyDatabaseIdentity,
  loadFailureDiagnostic,
} from './run';

// This checks the actual embedded script against a CAP_CHOWN-only permission model.
// It is not a Linux filesystem or Docker execution receipt.
describe('private volume initialization ownership order', () => {
  type Inode = { uid: number; gid: number; mode: number; directory: boolean };
  const names = ['app', 'pg', 'data', 'evidence'] as const;
  async function literal() {
    const source = await readFile(new URL('./run.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('run.ts', source, ts.ScriptTarget.Latest, true);
    const values: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'initializeSecrets') {
        if (!node.initializer || !ts.isNoSubstitutionTemplateLiteral(node.initializer))
          throw new Error('INITIALIZER_LITERAL_REQUIRED');
        values.push(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    if (values.length !== 1) throw new Error('ONE_INITIALIZER_REQUIRED');
    return values[0]!;
  }
  function permissionModel(
    owners: readonly number[],
    options: { capChown?: boolean; failure?: { operation: 'chown' | 'write'; error: Error }; existing?: boolean } = {},
  ) {
    const inodes = new Map<string, Inode>(
      names.map((name, i) => [`/owned/${name}`, { uid: owners[i]!, gid: owners[i]!, mode: 0o700, directory: true }]),
    );
    if (options.existing)
      inodes.set('/owned/app/database_url', { uid: 10001, gid: 10001, mode: 0o600, directory: false });
    const events: string[] = [];
    let writes = 0;
    function inode(path: string) {
      const value = inodes.get(path);
      if (!value) throw new Error('MODEL_ENOENT');
      return value;
    }
    function parentWritable(path: string) {
      const value = inode(path.slice(0, path.lastIndexOf('/')));
      if (!value.directory || value.uid !== 0 || (value.mode & 0o300) !== 0o300) throw new Error('MODEL_EACCES');
    }
    const fs = {
      chownSync(path: string, uid: number, gid: number) {
        events.push('chown');
        if (options.failure?.operation === 'chown') throw options.failure.error;
        if (options.capChown === false) throw new Error('MODEL_EPERM_CHOWN');
        const value = inode(path);
        value.uid = uid;
        value.gid = gid;
      },
      chmodSync(path: string, mode: number) {
        events.push('chmod');
        const value = inode(path);
        if (value.uid !== 0) throw new Error('MODEL_EPERM_CHMOD');
        value.mode = mode;
      },
      writeFileSync(path: string, _value: unknown, flags: { flag: string; mode: number }) {
        events.push('write');
        if (options.failure?.operation === 'write') throw options.failure.error;
        if (!['/owned/app/database_url', '/owned/pg/pg_password'].includes(path)) throw new Error('MODEL_PATH_INVALID');
        parentWritable(path);
        if (flags.flag !== 'wx' || flags.mode !== 0o600) throw new Error('MODEL_SECRET_FLAGS_INVALID');
        if (inodes.has(path)) throw new Error('MODEL_EEXIST');
        inodes.set(path, { uid: 0, gid: 0, mode: flags.mode, directory: false });
        writes++;
      },
    };
    function execute(script: string) {
      runInNewContext(
        script,
        {
          require(name: string) {
            if (name === 'node:fs') return fs;
            if (name === 'node:crypto') return { randomBytes: () => Buffer.alloc(48, 17) };
            throw new Error('MODEL_MODULE_INVALID');
          },
          process: {
            env: { LOAD_DATABASE: `opensamguk_load_${'a'.repeat(32)}_test` },
            exit: () => {
              throw new Error('MODEL_EXIT');
            },
          },
          console: new Proxy(
            {},
            {
              get: () => () => {
                throw new Error('MODEL_OUTPUT_FORBIDDEN');
              },
            },
          ),
        },
        { timeout: 1000 },
      );
    }
    return { inodes, events, execute, writes: () => writes };
  }
  function assertFinal(model: ReturnType<typeof permissionModel>) {
    expect(names.map((name) => model.inodes.get(`/owned/${name}`))).toEqual(
      [10001, 70, 70, 10001].map((uid) => ({ uid, gid: uid, mode: 0o700, directory: true })),
    );
    expect(model.inodes.get('/owned/app/database_url')).toEqual({
      uid: 10001,
      gid: 10001,
      mode: 0o600,
      directory: false,
    });
    expect(model.inodes.get('/owned/pg/pg_password')).toEqual({ uid: 70, gid: 70, mode: 0o600, directory: false });
    expect(model.inodes.size).toBe(6);
    expect(model.writes()).toBe(2);
  }
  it('reproduces the old first-chmod failure on an image-populated nonroot secret volume', async () => {
    const current = await literal();
    const takeOwnership = "fs.chownSync('/owned/'+name,0,0);";
    expect(current.split(takeOwnership)).toHaveLength(2);
    const model = permissionModel([10001, 0, 70, 0]);
    expect(() => model.execute(current.replace(takeOwnership, ''))).toThrow('MODEL_EPERM_CHMOD');
    expect(model.events).toEqual(['chmod']);
    expect(model.writes()).toBe(0);
  });
  it.each([
    [0, 0, 0, 0],
    [10001, 70, 70, 10001],
  ])('keeps final restrictive ownership with initial UIDs %j', async (...owners) => {
    const model = permissionModel(owners);
    model.execute(await literal());
    expect(model.events.slice(0, 8)).toEqual(names.flatMap(() => ['chown', 'chmod']));
    assertFinal(model);
  });
  it('still fails before writing without the existing CAP_CHOWN capability', async () => {
    const model = permissionModel([10001, 70, 70, 10001], { capChown: false });
    const script = await literal();
    expect(() => model.execute(script)).toThrow('MODEL_EPERM_CHOWN');
    expect(model.writes()).toBe(0);
  });
  it.each(['chown', 'write'] as const)(
    'propagates %s failure without continuing or emitting private data',
    async (operation) => {
      const error = new Error('private-error-canary');
      const model = permissionModel([10001, 70, 70, 10001], { failure: { operation, error } });
      const script = await literal();
      let caught: unknown;
      try {
        model.execute(script);
      } catch (failure) {
        caught = failure;
      }
      expect(caught === error).toBe(true);
      expect(model.writes()).toBe(0);
      expect(model.events.at(-1)).toBe(operation);
    },
  );
  it('keeps exclusive creation and does not overwrite an existing secret', async () => {
    const model = permissionModel([10001, 70, 70, 10001], { existing: true });
    const original = { ...model.inodes.get('/owned/app/database_url')! };
    const script = await literal();
    expect(() => model.execute(script)).toThrow('MODEL_EEXIST');
    expect(model.inodes.get('/owned/app/database_url')).toEqual(original);
    expect(model.inodes.has('/owned/pg/pg_password')).toBe(false);
    expect(model.writes()).toBe(0);
  });
});

describe('driver primary failure classification', () => {
  it('freezes the original stage before cleanup and never reads raw nested errors or getters', () => {
    const error = Object.assign(new Error('LOAD_CONTAINER_CGROUP_UNVERIFIED', { cause: new Error('private-canary') }), {
      stderr: 'private-canary',
      path: '/private-canary',
    });
    Object.defineProperty(error, 'name', {
      get() {
        throw new Error('name-canary');
      },
    });
    const primary = loadFailureDiagnostic('private-volume-init', error);
    const cleanup = loadFailureDiagnostic('cleanup', new Error('LOAD_CLEANUP_UNCONFIRMED'));
    expect(primary).toMatchObject({ stage: 'private-volume-init', code: 'LOAD_CONTAINER_CGROUP_UNVERIFIED' });
    expect(cleanup).toMatchObject({ stage: 'cleanup', code: 'LOAD_CLEANUP_UNCONFIRMED' });
    expect(primary.stage).toBe('private-volume-init');
    expect(JSON.stringify(primary)).not.toContain('canary');
    expect(loadFailureDiagnostic('/private-canary', new Error('/private-canary'))).toMatchObject({
      stage: 'unknown',
      code: 'UNCLASSIFIED',
    });
  });
  it('distinguishes fixed schema/resource/admission categories without copying input', () => {
    expect(loadFailureDiagnostic('admission', new Error('ADMISSION_REFUSED')).code).toBe('ADMISSION_REFUSED');
    expect(
      loadFailureDiagnostic('resources', Object.assign(new Error('private-canary'), { code: 'ENOENT' })).code,
    ).toBe('RESOURCE_MISSING');
    expect(
      loadFailureDiagnostic('resources', Object.assign(new Error('private-canary'), { code: 'EACCES' })).code,
    ).toBe('RESOURCE_DENIED');
    expect(loadFailureDiagnostic('report', Object.assign(new Error('private-canary'), { name: 'ZodError' })).code).toBe(
      'SCHEMA_INVALID',
    );
  });
});

describe('L4 실제 실행 전 소유권/source/compose 계약', () => {
  const host = {
    CgroupParent: LOAD_DOCKER.cgroupParent,
    NanoCpus: 0.5e9,
    Memory: 1024 ** 3,
    MemorySwap: 1024 ** 3,
    Privileged: false,
    ReadonlyRootfs: true,
    PortBindings: null,
  };
  it('저장소의 동일 compose에서 formal과 smoke 제한 합을 각각 읽는다', async () => {
    const source = await readFile(new URL('../../deploy/load/compose.yml', import.meta.url), 'utf8');
    expect(composeBudget(renderLoadCompose(source, 'formal'), 'formal')).toEqual({
      cpu: 3,
      memoryBytes: 5 * 1024 ** 3,
      diskBytes: 5 * 1024 ** 3,
    });
    expect(composeBudget(renderLoadCompose(source, 'smoke'), 'smoke')).toEqual({
      cpu: 1.25,
      memoryBytes: 2.5 * 1024 ** 3,
      diskBytes: 3 * 1024 ** 3,
    });
    for (const mode of ['formal', 'smoke'] as const) {
      const parsed: unknown = parse(renderLoadCompose(source, mode));
      expect(parsed).toMatchObject({
        services: {
          postgres: { cgroup_parent: LOAD_DOCKER.cgroupParent },
          server: { cgroup_parent: LOAD_DOCKER.cgroupParent, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,mode=1777'] },
          engine: { cgroup_parent: LOAD_DOCKER.cgroupParent, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,mode=1777'] },
          generator: { cgroup_parent: LOAD_DOCKER.cgroupParent, tmpfs: ['/tmp:rw,noexec,nosuid,size=64m,mode=1777'] },
        },
      });
    }
    expect(() =>
      renderLoadCompose(
        source.replace(
          "['/tmp:rw,noexec,nosuid,size=64m,mode=1777']",
          '[/tmp:rw, noexec, nosuid, size=64m, mode=1777]',
        ),
        'formal',
      ),
    ).toThrow('LOAD_COMPOSE_TMPFS_INVALID');
    expect(() =>
      renderLoadCompose(source.replaceAll('cgroup_parent: system.slice', 'cgroup_parent: narrow.slice'), 'formal'),
    ).toThrow('LOAD_CONTAINER_CGROUP_UNVERIFIED');
  });
  it('이미지 tag나 label 한쪽만 일치하는 source를 허용하지 않는다', () => {
    const labels = {
      'org.opencontainers.image.revision': 'a'.repeat(40),
      'org.opensamguk.source-tree-sha256': 'b'.repeat(64),
    };
    const image = { Id: `sha256:${'c'.repeat(64)}`, Config: { Labels: labels } };
    expect(requireImageSource([image], 'a'.repeat(40), 'b'.repeat(64))).toBe(image.Id);
    expect(() => requireImageSource([image], 'd'.repeat(40), 'b'.repeat(64))).toThrow();
    expect(() => requireImageSource([{ ...image, Id: 'latest' }], 'a'.repeat(40), 'b'.repeat(64))).toThrow();
  });
  it('네 서비스가 모두 새 UUID 프로젝트와 run label에 결속돼야 한다', () => {
    const rows = ['postgres', 'server', 'engine', 'generator'].map((name, index) => ({
      Id: String(index).repeat(64),
      Name: name,
      Config: {
        Labels: {
          'com.docker.compose.project': 'owned',
          'org.opensamguk.load.run': 'run',
          'com.docker.compose.service': name,
        },
      },
      State: { Running: true, OOMKilled: false, ExitCode: 0, FinishedAt: '' },
      HostConfig: host,
    }));
    expect(() => assertContainerOwnership(rows, 'owned', 'run')).not.toThrow();
    expect(() => assertContainerOwnership(rows.slice(0, 3), 'owned', 'run')).toThrow();
    expect(() => assertContainerOwnership(rows, 'peer', 'run')).toThrow();
    expect(() => assertContainerOwnership([...rows.slice(0, 3), rows[0]!], 'owned', 'run')).toThrow();
  });
  it('실제 Docker quota/image/loopback 바인딩을 source compose와 별도로 검사한다', () => {
    const row = {
      Id: 'a'.repeat(64),
      Name: '/owned-server-1',
      Config: { Labels: { 'com.docker.compose.service': 'server' } },
      State: { Running: false, OOMKilled: false, ExitCode: 0, FinishedAt: '' },
      Image: 'app-image',
      HostConfig: {
        CgroupParent: LOAD_DOCKER.cgroupParent,
        NanoCpus: 0.5e9,
        Memory: 1024 ** 3,
        MemorySwap: 1024 ** 3,
        Privileged: false,
        ReadonlyRootfs: true,
        PortBindings: { '3001/tcp': [{ HostIp: '127.0.0.1' }] },
      },
    };
    expect(() => assertContainerLimits([row], 'formal', 'app-image', 'pg-image')).not.toThrow();
    expect(() =>
      assertContainerLimits(
        [{ ...row, HostConfig: { ...row.HostConfig, NanoCpus: 0 } }],
        'formal',
        'app-image',
        'pg-image',
      ),
    ).toThrow();
    expect(() =>
      assertContainerLimits(
        [{ ...row, HostConfig: { ...row.HostConfig, PortBindings: { '3001/tcp': [{ HostIp: '0.0.0.0' }] } } }],
        'formal',
        'app-image',
        'pg-image',
      ),
    ).toThrow();
    expect(() => assertContainerLimits([{ ...row, Image: 'peer' }], 'formal', 'app-image', 'pg-image')).toThrow();
    expect(() =>
      assertContainerLimits(
        [{ ...row, HostConfig: { ...row.HostConfig, CgroupParent: 'narrow.slice' } }],
        'formal',
        'app-image',
        'pg-image',
      ),
    ).toThrow('LOAD_CONTAINER_CGROUP_UNVERIFIED');
  });
  it('중도 실패의 임시 컨테이너도 정확 이름과 run/project label이 있어야 정리 후보가 된다', () => {
    const row = {
      Id: 'a'.repeat(64),
      Name: '/owned-migrations',
      Config: {
        Labels: {
          'com.docker.compose.project': 'owned',
          'org.opensamguk.load.run': 'run',
          'com.docker.compose.oneoff': 'True',
        },
      },
      State: { Running: true, OOMKilled: false, ExitCode: 0, FinishedAt: '' },
    };
    expect(partitionOwnedContainers([row], 'owned', 'run').auxiliary).toEqual([row]);
    expect(() => partitionOwnedContainers([{ ...row, Name: '/owned-peer' }], 'owned', 'run')).toThrow();
    expect(() => partitionOwnedContainers([row], 'owned', 'peer-run')).toThrow();
  });
  it('DB 이름/OID가 재생성됐거나 연결 수를 모르면 삭제 근거로 인정하지 않는다', () => {
    const text = JSON.stringify({ name: 'owned_test', oid: 101, connections: 0 });
    expect(verifyDatabaseIdentity(text, { name: 'owned_test', oid: 101 })).toEqual({
      name: 'owned_test',
      oid: 101,
      connections: 0,
    });
    expect(() => verifyDatabaseIdentity(text, { name: 'owned_test', oid: 102 })).toThrow();
    expect(() => verifyDatabaseIdentity(text, { name: 'peer_test' })).toThrow();
    expect(() => verifyDatabaseIdentity('{"name":"owned_test","oid":101}', { name: 'owned_test' })).toThrow();
    expect(() => verifyDatabaseIdentity('private-canary', { name: 'owned_test' })).toThrow(
      /^LOAD_DATABASE_IDENTITY_INVALID$/,
    );
  });
});
