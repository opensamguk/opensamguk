import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// eslint.config.js의 경계 규칙이 실제로 막는지 확인한다 (AC-M1-01).
const eslint = new ESLint();

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'parse-error');
}

describe('결정성 규칙', () => {
  it('rules에서 Math.random을 막는다', async () => {
    expect(await ruleIds('export const r = Math.random();\n', 'packages/rules/src/x.ts')).toContain(
      'no-restricted-properties',
    );
  });

  it('rules에서 현재 시각을 막는다', async () => {
    const ids = await ruleIds('export const a = Date.now();\nexport const b = new Date();\n', 'packages/rules/src/x.ts');
    expect(ids).toEqual(expect.arrayContaining(['no-restricted-properties', 'no-restricted-syntax']));
  });

  it('engine에서도 Math.random을 막는다', async () => {
    expect(await ruleIds('export const r = Math.random();\n', 'apps/engine/src/x.ts')).toContain(
      'no-restricted-properties',
    );
  });
});

describe('패키지 경계', () => {
  it('rules는 db를 import할 수 없다', async () => {
    expect(await ruleIds("import { createDb } from '@opensamguk/db';\nexport { createDb };\n", 'packages/rules/src/x.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('rules는 node 내장 모듈을 import할 수 없다', async () => {
    // 리뷰 T1-01: 접두사 없는 이름과 하위 경로도 막아야 한다
    const specifiers = ['node:fs', 'fs', 'crypto', 'node:crypto', 'dns/promises', 'node:dns/promises', 'fs/promises', 'timers/promises'];
    for (const spec of specifiers) {
      const code = `import * as m from '${spec}';\nexport { m };\n`;
      expect(await ruleIds(code, 'packages/rules/src/x.ts'), spec).toContain('no-restricted-imports');
    }
  });

  it('web은 server에서 타입만 import할 수 있다', async () => {
    const typeOnly = "import type { AppRouter } from '@opensamguk/server/router';\nexport type { AppRouter };\n";
    const value = "import { appRouter } from '@opensamguk/server/router';\nexport { appRouter };\n";
    expect(await ruleIds(typeOnly, 'apps/web/src/x.ts')).not.toContain('no-restricted-imports');
    expect(await ruleIds(value, 'apps/web/src/x.ts')).toContain('no-restricted-imports');
  });

  it('상대 경로로 다른 패키지를 import할 수 없다', async () => {
    const cases: Array<[string, string]> = [
      ["export { RULESET_ID } from '../../../packages/rules/src/index';\n", 'apps/engine/src/x.ts'],
      // 리뷰 T1-01: 형제 패키지 경로는 문자열에 apps·packages가 없다
      ["import { createDb } from '../../db/src/index';\nexport { createDb };\n", 'packages/rules/src/x.ts'],
      ["import { appRouter } from '../../server/src/router';\nexport { appRouter };\n", 'apps/web/src/x.ts'],
      ["export * from '../../../shared/src/index';\n", 'packages/rules/src/deep/x.ts'],
    ];
    for (const [code, file] of cases) {
      expect(await ruleIds(code, file), file).toContain('opensamguk/no-cross-package-relative');
    }
  });

  it('같은 패키지 안의 상대 경로는 허용한다', async () => {
    expect(await ruleIds("export * from '../model/index';\n", 'packages/rules/src/commands/x.ts')).not.toContain(
      'opensamguk/no-cross-package-relative',
    );
  });
});
