import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeCli, pnpmCli } from './node-cli';

const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opensamguk 한글 cli '));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) {
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

describe('AC-M1-22 AC-M1-13 Windows CLI 실행', () => {
  it('실제 자식에게 인수·환경·cwd를 그대로 넘기고 출력과 실패 코드를 받는다', () => {
    const dir = fixture();
    const entrypoint = join(dir, '실행 파일.cjs');
    writeFileSync(
      entrypoint,
      `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), value: process.env.OPENSAMGUK_CLI_VALUE }));
console.error('child stderr');
process.exitCode = 7;
`,
    );
    const args = ['', 'two words', '"quoted"', '한글', '& echo shell', '$(echo shell)', '%PATH%'];
    const result = spawnSync(...nodeCli(entrypoint, args), {
      cwd: dir,
      env: { ...process.env, OPENSAMGUK_CLI_VALUE: '환경 값' },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: dir, value: '환경 값' });
    expect(result.stderr.trim()).toBe('child stderr');
  });

  it('없는 JavaScript 진입 파일은 실제 실행에서 실패한다', () => {
    const result = spawnSync(...nodeCli(join(fixture(), 'missing.cjs'), []), { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MODULE_NOT_FOUND');
  });

  it('작업 폴더가 없으면 시작 실패와 null 상태를 받는다', () => {
    const result = spawnSync(...nodeCli('-e', ['process.exitCode = 0']), {
      cwd: join(fixture(), 'missing'),
      encoding: 'utf8',
    });
    expect(result.status).toBeNull();
    expect(result.error).toHaveProperty('code', 'ENOENT');
  });

  it.each(['pnpm.cjs', 'pnpm.js', 'pnpm.mjs'])('pnpm 실행 환경의 %s 경로와 인수를 사용한다', (name) => {
    const entrypoint = join(fixture(), name);
    const args = ['--filter', '@opensamguk/db', 'migrate'];
    expect(pnpmCli(args, { npm_execpath: entrypoint })).toEqual([process.execPath, [entrypoint, ...args]]);
  });

  it.each([undefined, '', 'pnpm', 'pnpm.cmd', 'npm-cli.js'])(
    'pnpm JS 경로가 %s이면 shell로 대체하지 않는다',
    (path) => {
      const env: NodeJS.ProcessEnv = path === undefined ? {} : { npm_execpath: path };
      expect(() => pnpmCli(['test:int'], env)).toThrow('pnpm으로 실행하세요');
    },
  );

  it('Windows 환경을 복사한 대문자 키도 같은 JS 실행 경로로 검사한다', () => {
    const entrypoint = join(fixture(), 'pnpm.cjs');
    expect(pnpmCli(['migrate'], { NPM_EXECPATH: entrypoint })).toEqual([process.execPath, [entrypoint, 'migrate']]);
    expect(() => pnpmCli(['migrate'], { NPM_EXECPATH: 'pnpm.cmd' })).toThrow('pnpm으로 실행하세요');
  });
});
