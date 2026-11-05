import { execFile } from 'node:child_process';
import { globSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';

it('T2-15 AC-M2-08 실제 번들에 개발 코드가 없고 argon2 native 해시가 작동한다', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sourceRequire = createRequire(new URL('../apps/server/package.json', import.meta.url));
  await promisify(execFile)(process.execPath, ['tools/runtime-bundle/build.mjs'], { cwd: root });
  for (const target of ['server', 'engine']) {
    const meta = JSON.parse(
      await readFile(new URL(`../dist/runtime/${target}/metafile.json`, import.meta.url), 'utf8'),
    ) as {
      inputs: Record<string, unknown>;
    };
    const inputs = Object.keys(meta.inputs);
    expect(inputs.some((name) => /query_compiler_fast_bg.postgresql.wasm-base64.mjs$/.test(name))).toBe(true);
    expect(inputs.filter((name) => /\.test\.|\/authz\/|\/tsx\/|\/vitest\//.test(name))).toEqual([]);
    const notices = await readFile(
      new URL(`../dist/runtime/${target}/THIRD_PARTY_NOTICES.txt`, import.meta.url),
      'utf8',
    );
    const pgLicense = await readFile(
      new URL('./LICENSE', pathToFileURL(sourceRequire.resolve('pg/package.json'))),
      'utf8',
    );
    expect(notices).toContain(pgLicense);
  }
  const require = createRequire(new URL('../dist/runtime/server/server.mjs', import.meta.url));
  const argon2 = require('argon2') as typeof import('argon2');
  const hash = await argon2.hash('T2-15 native module check');
  expect(await argon2.verify(hash, 'T2-15 native module check')).toBe(true);
  expect(await argon2.verify(hash, 'different value')).toBe(false);
}, 30_000);

it('T4-95 AC-P2-32 실행 이미지의 원장 복사 목록으로 모든 성별 판을 읽는다', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'opensamguk-runtime-ledgers-'));
  try {
    await mkdir(join(directory, 'officers'));
    const dockerfile = await readFile(new URL('../deploy/Dockerfile', import.meta.url), 'utf8');
    const stage = dockerfile.split(/FROM runtime AS app-runtime\r?\n/)[1]?.split(/\r?\nFROM /)[0];
    expect(stage).toBeTypeOf('string');
    const copies = stage!.split(/\r?\n/).filter((line) => line.startsWith('COPY resources/officers/'));
    expect(copies.length).toBeGreaterThan(0);
    for (const line of copies) {
      const fields = line.trim().split(/\s+/);
      expect(fields.at(-1)).toBe('/app/resources/officers/');
      for (const pattern of fields.slice(1, -1)) {
        const files = globSync(pattern, { cwd: root });
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) await copyFile(join(root, file), join(directory, 'officers', basename(file)));
      }
    }
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OPENSAMGUK_RESOURCES_ROOT', directory);
    vi.resetModules();
    const { loadSexLedger, loadSexLedgers } = await import('../apps/engine/src/world/resources');
    const ledgers = loadSexLedgers();
    expect(ledgers.length).toBeGreaterThan(0);
    expect(loadSexLedger()).toBe(ledgers.at(-1));
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    expect(dirname(directory)).toBe(temporaryRoot);
    expect(basename(directory)).toMatch(/^opensamguk-runtime-ledgers-/);
    await rm(directory, { recursive: true, force: true });
  }
});
