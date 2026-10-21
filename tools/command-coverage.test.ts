import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { commands } from '../packages/rules/src/index';

it('AC-M1-14 모든 registry key에 성공·실패 행동 테스트 파일이 있다', async () => {
  for (const command of commands) {
    const source = await readFile(
      new URL(`../packages/rules/src/commands/${command.key}.test.ts`, import.meta.url),
      'utf8',
    );
    expect(source).toContain("it('성공'");
    expect(source).toContain("it('실패'");
    expect(source).toContain(`verifySuccess('${command.key}')`);
    expect(source).toContain(`verifyFailure('${command.key}')`);
  }
});
