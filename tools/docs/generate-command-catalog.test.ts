import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commands, extensionCommands } from '../../packages/rules/src/index';
import { checkCommandCatalog, generateCommandCatalog } from './generate-command-catalog';

describe('AC-M2-11 명령 목록 생성', () => {
  it('등록된 기본·프리셋 명령을 모두 결정적으로 생성한다', async () => {
    const first = await generateCommandCatalog();
    expect(await generateCommandCatalog()).toEqual(first);
    const markdown = first.toString('utf8');
    expect(markdown.split('\n').filter((line) => /^\| (내정|군사|전략|개인|국가) \|/.test(line))).toHaveLength(
      commands.length + extensionCommands.length,
    );
    expect(markdown).toContain('## 장수 명령');
    expect(markdown).toContain('## 국가 명령');
    expect(markdown).toContain('| 전략 | 무작위 임관 | 임관 가능한 국가 가운데 한 곳에 들어갑니다. | 없음 |');
    expect(markdown).toContain('일부 월드에서는 쓸 수 없음');
    expect(markdown).not.toContain('\r');
    await expect(checkCommandCatalog()).resolves.toBeUndefined();
  });

  it('저장된 파일이 한 바이트라도 다르면 읽기 검사에서 실패하고 파일은 보존한다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opensamguk-command-catalog-'));
    const file = pathToFileURL(join(directory, 'catalog.md'));
    const changed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await generateCommandCatalog()]);
    await writeFile(file, changed);
    try {
      await expect(checkCommandCatalog(file)).rejects.toThrow('pnpm docs:generate');
      expect(await readFile(file)).toEqual(changed);
    } finally {
      await unlink(file);
      await rmdir(directory);
    }
  });
});
