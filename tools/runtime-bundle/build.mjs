import { build } from 'esbuild';
import { cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, 'dist/runtime');
const banner = `import { createRequire as runtimeCreateRequire } from 'node:module';
import { fileURLToPath as runtimeFileURLToPath } from 'node:url';
import { dirname as runtimeDirname } from 'node:path';
const require = runtimeCreateRequire(import.meta.url);
const __filename = runtimeFileURLToPath(import.meta.url);
const __dirname = runtimeDirname(__filename);`;

for (const target of ['server', 'engine']) {
  const directory = join(output, target);
  await mkdir(directory, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`apps/${target}/src/index.ts`],
    outfile: join(directory, `${target}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['argon2', 'pg-native'],
    define: { __OPENSAMGUK_RUNTIME_BUNDLE__: 'true' },
    banner: { js: banner },
    metafile: true,
    logLevel: 'info',
  });
  const forbidden = Object.keys(result.metafile.inputs).filter((name) =>
    /(?:^|\/)(?:tsx|vitest)(?:@|\/)|\.test\.[cm]?[jt]s$|apps\/server\/src\/authz\/|prisma\/build\//.test(name),
  );
  if (forbidden.length) throw new Error(`운영 번들에 시험·개발 코드가 들어갔습니다: ${forbidden.join(', ')}`);
  await writeFile(join(directory, 'metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n');
}

// argon2의 JS 실행 경로만 남긴다. cross-env·node-addon-api는 설치·컴파일 때만 쓴다.
const serverRequire = createRequire(join(root, 'apps/server/package.json'));
const argonRoot = dirname(await realpath(serverRequire.resolve('argon2/package.json')));
const argonRequire = createRequire(join(argonRoot, 'package.json'));
const nativeOutput = join(output, 'server/node_modules');
const argonOutput = join(nativeOutput, 'argon2');
await mkdir(argonOutput, { recursive: true });
for (const name of ['package.json', 'argon2.cjs', 'LICENSE']) await cp(join(argonRoot, name), join(argonOutput, name));
await mkdir(join(argonOutput, 'prebuilds'), { recursive: true });
await cp(
  join(argonRoot, 'prebuilds', `${process.platform}-${process.arch}`),
  join(argonOutput, 'prebuilds', `${process.platform}-${process.arch}`),
  { recursive: true },
);
for (const dependency of ['@phc/format', 'node-gyp-build']) {
  const source = dirname(await realpath(argonRequire.resolve(`${dependency}/package.json`)));
  const destination = join(nativeOutput, dependency);
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    filter: (path) =>
      !['node_modules', 'test', 'tests', '.github'].includes(path.slice(source.length + 1).split(/[\\/]/)[0]),
  });
}
const manifest = JSON.parse(await readFile(join(argonOutput, 'package.json'), 'utf8'));
if (manifest.version !== '0.45.1') throw new Error('argon2 실행 파일 목록을 새 버전과 대조하세요.');
