import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('T2-15 AC-M2-08 실제 번들에 개발 코드가 없고 argon2 native 해시가 작동한다', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
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
  }
  const require = createRequire(new URL('../dist/runtime/server/server.mjs', import.meta.url));
  const argon2 = require('argon2') as typeof import('argon2');
  const hash = await argon2.hash('T2-15 native module check');
  expect(await argon2.verify(hash, 'T2-15 native module check')).toBe(true);
  expect(await argon2.verify(hash, 'different value')).toBe(false);
}, 30_000);
