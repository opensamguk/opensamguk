import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCommandCatalog, generateCommandCatalog } from './generate-command-catalog';

describe('AC-M2-11 명령 목록 생성', () => {
  it('기본·프리셋·월드 규칙 명령 60개와 실제 인자를 결정적으로 생성한다', async () => {
    const first = await generateCommandCatalog();
    expect(await generateCommandCatalog()).toEqual(first);
    const markdown = first.toString('utf8');
    expect(markdown.split('\n').filter((line) => /^\| (내정|군사|전략|개인|국가) \|/.test(line))).toHaveLength(60);
    expect(markdown).toContain('## 장수 명령');
    expect(markdown).toContain('## 국가 명령');
    expect(markdown).toContain('| 전략 | 무작위 임관 | 임관 가능한 국가 가운데 한 곳에 들어갑니다. | 없음 |');
    expect(markdown).toContain('| 군사 | 훈련 | 병력의 훈련도를 높입니다. | 대상 부곡, 훈련 대상, 병종 |');
    expect(markdown).toContain('| 군사 | 빈 부곡 편성 |');
    expect(markdown).toContain(
      '| 국가 | 도시 병력 배속 | 도시 수비병을 같은 병종의 부곡으로 옮깁니다. | 대상 도시, 대상 부곡, 병종, 수량 |',
    );
    expect(markdown).toContain('| 국가 | 극병 연구 |');
    expect(markdown).toContain('준비를 포함한 24턴 | 국고 금 100000, 쌀 100000');
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
