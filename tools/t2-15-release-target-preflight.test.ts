import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parse as yaml } from 'yaml';
import { createTargetFixture } from './t2-15-release-target-linux.mts';
import { hashFile, fileInventory } from './release-artifact';
import {
  nonsecretKeys,
  normalizedCompose,
  officialImages,
  parseTargetEnvironment,
  performTarget,
  preflightTarget,
  runTargetNative,
  TargetPreflightError,
  targetInput,
  verifyTargetCompose,
  verifyTargetImages,
  verifyTargetVolumes,
  volumePurposes,
} from './release-target-preflight';

let owned: string;
beforeAll(async () => {
  owned = await mkdtemp(join(tmpdir(), 'opensamguk-target-pure-'));
});
afterAll(async () => {
  const root = resolve(owned);
  if (!basename(root).startsWith('opensamguk-target-pure-') || relative(resolve(tmpdir()), root).startsWith('..'))
    throw new Error('OWN_TEST_DIRECTORY');
  await rm(root, { recursive: true });
});
let fixtureCount = 0;
async function fixture() {
  const f = await createTargetFixture(join(owned, String(++fixtureCount)));
  const receipt = JSON.parse(await readFile(f.input.artifact.preflightReceiptPath, 'utf8'));
  const images = f.manifest.images.map((image) => ({
    Id: image.id,
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      User: '10001:10001',
      Labels: {
        'org.opencontainers.image.revision': receipt.sourceRevision,
        'org.opensamguk.source-tree-sha256': f.tree,
      },
      Env: ['NODE_ENV=production', 'PATH=/usr/bin:/bin'],
    },
  }));
  const volumes = Object.entries(volumePurposes).map(([key, purpose]) => ({
    Name: f.input.target.volumes[key as keyof typeof volumePurposes],
    Driver: 'local',
    Scope: 'local',
    CreatedAt: '2026-10-30T00:00:00Z',
    Mountpoint: '/metadata/' + purpose,
    Options: null,
    Labels: {
      'org.opensamguk.owner': f.input.target.ownerId,
      'org.opensamguk.target': f.input.target.targetId,
      'org.opensamguk.purpose': purpose,
    },
  }));
  const template = await readFile(f.input.target.composeFile, 'utf8');
  const interpolated = template.replace(
    /\$\{([A-Z_]+):\?\}/g,
    (_, key: string) => f.environment[key as keyof typeof f.environment],
  );
  const model = normalizedCompose(
    yaml(interpolated, { merge: true }),
    f.input.target.projectName,
    join(f.context, 'deploy'),
  );
  const calls: string[][] = [];
  const native: typeof runTargetNative = async (_exe, args, signal) => {
    signal.throwIfAborted();
    calls.push(args);
    expect(args.slice(0, 4)).toEqual([
      '--host',
      'unix:///var/run/docker.sock',
      '--config',
      f.input.target.dockerConfigDirectory,
    ]);
    const command = args.slice(4),
      kind = command[0];
    if (kind === 'info') return JSON.stringify({ ID: 'fixture-daemon', OSType: 'linux', Architecture: 'x86_64' });
    if (kind === 'version') return '{}';
    if (kind === 'compose') return JSON.stringify(model);
    if (kind === 'volume') return volumes.map((v) => JSON.stringify(v)).join('\n');
    if (kind === 'image' && command.includes(officialImages.postgres))
      return Object.values(officialImages)
        .map((reference, i) =>
          JSON.stringify({
            Id: 'sha256:' + String(i + 4).repeat(64),
            Os: 'linux',
            Architecture: 'amd64',
            RepoDigests: [reference.replace(/:[^:@]+@/, '@')],
          }),
        )
        .join('\n');
    if (kind === 'image') return images.map((v) => JSON.stringify(v)).join('\n');
    throw new Error('UNEXPECTED_NATIVE');
  };
  const platform = async () => 'controlled-platform-no-docker';
  return { ...f, receipt, images, volumes, template, model, calls, native, platform };
}
it('AC-M2-08 metadata 입력은 정확한 필드와 local socket만 받는다', async () => {
  const f = await fixture();
  expect(targetInput.safeParse(f.input).success).toBe(true);
  for (const extra of [
    { ...f.input, deploy: true },
    { ...f.input, target: { ...f.input.target, dockerHost: 'tcp://remote:2375' } },
    { ...f.input, target: { ...f.input.target, ownerId: '../outside' } },
  ])
    expect(targetInput.safeParse(extra).success).toBe(false);
});
it('AC-M2-08 환경은 기존16개 비밀 아닌 키만 허용한다', async () => {
  const f = await fixture(),
    text = await readFile(f.input.target.environmentFile, 'utf8');
  expect(Object.keys(parseTargetEnvironment(text)).sort()).toEqual([...nonsecretKeys].sort());
  for (const extra of [
    'DATABASE_URL=canary\n',
    'MAIL_API_KEY=canary\n',
    'SERVER_IMAGE=duplicate\n',
    'UNKNOWN=canary\n',
  ])
    expect(() => parseTargetEnvironment(text + extra)).toThrow();
  for (const value of [
    text.replace('metadata.invalid', '${AMBIENT}'),
    text.replace('metadata.invalid', '`command`'),
    text.replace('PUBLIC_HOST=', 'PUBLIC_HOST="'),
    text.replace('HTTP_PORT=18080', 'HTTP_PORT=70000'),
  ])
    expect(() => parseTargetEnvironment(value)).toThrow();
});
for (const property of ['id', 'user', 'revision', 'tree', 'credential', 'architecture'] as const)
  it(`AC-M2-08 이미지 ${property} 불일치를 거부한다`, async () => {
    const f = await fixture(),
      rows = structuredClone(f.images);
    if (property === 'id') rows[0]!.Id = 'sha256:' + 'f'.repeat(64);
    if (property === 'user') rows[0]!.Config.User = '0:0';
    if (property === 'revision') rows[0]!.Config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40);
    if (property === 'tree') rows[0]!.Config.Labels['org.opensamguk.source-tree-sha256'] = 'b'.repeat(64);
    if (property === 'credential') rows[0]!.Config.Env.push('MAIL_API_KEY=canary');
    if (property === 'architecture') rows[0]!.Architecture = 'arm64';
    expect(() => verifyTargetImages(rows, f.receipt)).toThrow();
  });
for (const key of ['org.opensamguk.owner', 'org.opensamguk.target', 'org.opensamguk.purpose'] as const)
  it(`AC-M2-08 volume ${key} 불일치를 거부한다`, async () => {
    const f = await fixture();
    expect(verifyTargetVolumes(f.volumes, f.input.target)).toHaveLength(4);
    const wrong = structuredClone(f.volumes);
    (wrong[0]!.Labels as Record<string, string>)[key] = 'other';
    expect(() => verifyTargetVolumes(wrong, f.input.target)).toThrow();
    delete (wrong[0]!.Labels as Record<string, string>)[key];
    expect(() => verifyTargetVolumes(wrong, f.input.target)).toThrow();
  });
it('AC-M2-08 중복 volume·다른 driver와 scope를 채택하지 않는다', async () => {
  const f = await fixture();
  for (const value of [
    [f.volumes[0], f.volumes[0], ...f.volumes.slice(2)],
    f.volumes.map((v, i) => (i ? v : { ...v, Driver: 'remote' })),
    f.volumes.map((v, i) => (i ? v : { ...v, Scope: 'global' })),
    f.volumes.map((v, i) => (i ? v : { ...v, Options: { type: 'none', o: 'bind', device: '/unexpected' } })),
  ])
    expect(() => verifyTargetVolumes(value, f.input.target)).toThrow();
});
for (const change of ['root', 'port', 'network', 'mount', 'image', 'extra-service', 'command', 'extra-field'] as const)
  it(`AC-M2-08 Compose ${change} override를 거부한다`, async () => {
    const f = await fixture(),
      model = structuredClone(f.model) as { services: Record<string, Record<string, unknown>> };
    expect(() => verifyTargetCompose(model, f.template, f.environment, f.input.target)).not.toThrow();
    if (change === 'root') model.services.server!.user = '0:0';
    if (change === 'port') model.services.postgres!.ports = ['0.0.0.0:5432:5432'];
    if (change === 'network') model.services.caddy!.network_mode = 'host';
    if (change === 'mount') (model.services.server!.volumes as Array<Record<string, unknown>>)[0]!.read_only = false;
    if (change === 'image') model.services.engine!.image = 'untrusted:latest';
    if (change === 'extra-service') model.services.extra = { image: 'untrusted:latest' };
    if (change === 'command') model.services.migrate!.command = ['unexpected'];
    if (change === 'extra-field') model.services.server!.privileged = true;
    expect(() => verifyTargetCompose(model, f.template, f.environment, f.input.target)).toThrow();
  });
it('AC-M2-08 fresh artifact와 metadata를 대조한 부분 receipt만 쓰고 원본은 보존한다', async () => {
  const f = await fixture(),
    before = await fileInventory(f.release);
  const result = await performTarget(f.input, f.native, new AbortController().signal, f.platform);
  const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as Record<string, unknown>;
  expect(receipt).toMatchObject({
    outcome: 'target-metadata-preflight-passed',
    images: 3,
    officialImages: 2,
    volumes: 4,
    operationalReady: false,
    secretUidModeVerified: false,
    dbQueried: false,
    secretsRead: false,
    deploymentStarted: false,
    currentChanged: false,
    rollbackAuthorized: false,
    dataContract: 'unknown',
  });
  expect(await fileInventory(f.release)).toEqual(before);
  expect((await hashFile(result.receiptPath)).sha256).toBe(result.receiptSha256);
  expect(f.calls.every((args) => ['version', 'info', 'image', 'volume', 'compose'].includes(args[4]!))).toBe(true);
  expect(f.calls.some((args) => args.includes('exec') || args.includes('run') || args.includes('up'))).toBe(false);
  await expect(performTarget(f.input, f.native, new AbortController().signal, f.platform)).rejects.toThrow();
  expect((await hashFile(result.receiptPath)).sha256).toBe(result.receiptSha256);
});
it('AC-M2-08 Docker canonical 기본값만 정규화하고 새 권한은 허용하지 않는다', async () => {
  const f = await fixture();
  const model = structuredClone(f.model) as { services: Record<string, Record<string, unknown>> };
  for (const service of Object.values(model.services)) {
    if (service.networks)
      service.networks = Object.fromEntries(Object.keys(service.networks).map((key) => [key, null]));
    if (service.depends_on)
      for (const d of Object.values(service.depends_on as Record<string, Record<string, unknown>>)) d.required = true;
    for (const mount of (service.volumes ?? []) as Array<Record<string, unknown>>) {
      if (mount.type === 'volume') mount.volume = {};
      mount.read_only ??= false;
    }
    for (const port of (service.ports ?? []) as Array<Record<string, unknown>>) {
      port.mode = 'ingress';
      port.protocol = 'tcp';
    }
  }
  expect(() => verifyTargetCompose(model, f.template, f.environment, f.input.target)).not.toThrow();
  model.services.server!.cap_add = ['SYS_ADMIN'];
  expect(() => verifyTargetCompose(model, f.template, f.environment, f.input.target)).toThrow();
});
it('AC-M2-08 과거 receipt가 있어도 현재 artifact 변조를 Docker 전에 거부한다', async () => {
  const f = await fixture();
  await writeFile(join(f.release, 'payload/images.tar'), 'tampered');
  await expect(performTarget(f.input, f.native, new AbortController().signal, f.platform)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it('AC-M2-08 daemon ID 불일치와 검사 중 volume 교체를 거부한다', async () => {
  const f = await fixture();
  f.input.target.expectedDaemonId = 'wrong';
  await expect(performTarget(f.input, f.native, new AbortController().signal, f.platform)).rejects.toThrow();
  const g = await fixture();
  let inspections = 0;
  const native: typeof runTargetNative = async (exe, args, signal) => {
    if (args[4] === 'volume' && ++inspections === 2) g.volumes[0]!.CreatedAt = 'replaced';
    return g.native(exe, args, signal);
  };
  await expect(performTarget(g.input, native, new AbortController().signal, g.platform)).rejects.toThrow();
});
it('AC-M2-08 native 완료 뒤 취소를 확인해 다음 명령과 최종 receipt를 막는다', async () => {
  const f = await fixture(),
    abort = new AbortController();
  const native: typeof runTargetNative = async (exe, args, signal) => {
    const result = await f.native(exe, args, signal);
    abort.abort();
    return result;
  };
  await expect(performTarget(f.input, native, abort.signal, f.platform)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
it('AC-M2-08 metadata 조회 중 artifact가 바뀌면 마지막 재검증이 거부한다', async () => {
  const f = await fixture();
  let changed = false;
  const native: typeof runTargetNative = async (exe, args, signal) => {
    const result = await f.native(exe, args, signal);
    if (args[4] === 'compose' && !changed) {
      changed = true;
      await writeFile(join(f.release, 'payload/images.tar'), 'changed-after-first-artifact-check');
    }
    return result;
  };
  await expect(performTarget(f.input, native, new AbortController().signal, f.platform)).rejects.toThrow();
  expect(changed).toBe(true);
});
it('AC-M2-08 과거 receipt의 다른 소스 사실과 환경 파일 해시 교체를 거부한다', async () => {
  const f = await fixture();
  const old = JSON.parse(await readFile(f.input.artifact.preflightReceiptPath, 'utf8')) as Record<string, unknown>;
  old.sourceTreeSha256 = 'b'.repeat(64);
  await writeFile(f.input.artifact.preflightReceiptPath, JSON.stringify(old));
  f.input.artifact.preflightReceiptSha256 = (await hashFile(f.input.artifact.preflightReceiptPath)).sha256;
  await expect(performTarget(f.input, f.native, new AbortController().signal, f.platform)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const g = await fixture();
  await writeFile(g.input.target.environmentFile, 'private-canary');
  await expect(performTarget(g.input, g.native, new AbortController().signal, g.platform)).rejects.toThrow();
  expect(g.calls).toHaveLength(0);
});
it('AC-M2-08 malformed private 입력은 고정 오류이며 원문 canary를 내보내지 않는다', async () => {
  await expect(preflightTarget({ private: 'canary' })).rejects.toThrow(
    '운영 대상 metadata 사전 확인을 마치지 못했습니다.',
  );
});
it('AC-M2-08 실제 native 종료와 양쪽 EOF만 성공이며 stderr·오류 원문은 버린다', async () => {
  const result = await runTargetNative(
    process.execPath,
    ['-e', 'process.stdout.write("ok");process.stderr.write("canary-not-for-log")'],
    new AbortController().signal,
  );
  expect(result).toBe('ok');
  await expect(
    runTargetNative(
      process.execPath,
      ['-e', 'process.stderr.write("canary-not-for-log");process.exitCode=1'],
      new AbortController().signal,
    ),
  ).rejects.toThrow('운영 대상 metadata 사전 확인을 마치지 못했습니다.');
});
it('AC-M2-08 실제 native 취소는 자기 자식 종료·EOF 뒤 고정 실패로 끝난다', async () => {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 50);
  try {
    const result = await runTargetNative(process.execPath, ['-e', 'setInterval(()=>{},1000)'], abort.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(TargetPreflightError);
    if (!(result instanceof TargetPreflightError)) throw new Error('EXPECTED_NATIVE_FAILURE');
    expect(result.code).toBe('NATIVE');
    expect(result.stickyUnsettled).toBe(false);
  } finally {
    clearTimeout(timer);
  }
});
