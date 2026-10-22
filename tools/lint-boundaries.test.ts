import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// eslint.config.js의 경계 규칙이 실제로 막는지 확인한다 (AC-M1-01).
const eslint = new ESLint();

// Cold plugin loading can exceed a single assertion's timeout on a busy machine.
beforeAll(async () => {
  await eslint.calculateConfigForFile('packages/rules/src/x.ts');
}, 30_000);

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
    const ids = await ruleIds(
      'export const a = Date.now();\nexport const b = new Date();\n',
      'packages/rules/src/x.ts',
    );
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
    expect(
      await ruleIds("import { createDb } from '@opensamguk/db';\nexport { createDb };\n", 'packages/rules/src/x.ts'),
    ).toContain('no-restricted-imports');
  });

  it('rules는 node 내장 모듈을 import할 수 없다', async () => {
    // 리뷰 T1-01: 접두사 없는 이름과 하위 경로도 막아야 한다
    const specifiers = [
      'node:fs',
      'fs',
      'crypto',
      'node:crypto',
      'dns/promises',
      'node:dns/promises',
      'fs/promises',
      'timers/promises',
    ];
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
    expect(await ruleIds("export * from '../clock/constants';\n", 'packages/rules/src/world/x.ts')).toEqual([]);
    expect(await ruleIds("export * from '@opensamguk/shared/node';\n", 'packages/rules/src/x.ts')).toContain(
      'no-restricted-imports',
    );
  });
});

// T4-34 예외 E1·E2 (docs/architecture/package-boundaries.md). 정확한 파일만 열리고 이웃 파일은 계속 막힌다.
describe('전투 시뮬레이터 예외', () => {
  const rulesValue = "import { simulateBattle } from '@opensamguk/rules';\nexport { simulateBattle };\n";
  const unitSetJson = "import basic from '../../../../resources/unitset/basic.json';\nexport { basic };\n";

  it('E1: compute.ts·compute.test.ts만 rules의 정해진 값과 타입을 import한다', async () => {
    const allowed =
      "import { BALANCE, simulateBattle, unitSetSchema, type UnitSetResource } from '@opensamguk/rules';\n" +
      'export type U = UnitSetResource;\nexport { BALANCE, simulateBattle, unitSetSchema };\n';
    for (const file of ['apps/web/src/battleSim/compute.ts', 'apps/web/src/battleSim/compute.test.ts']) {
      expect(await ruleIds(allowed, file), file).toEqual([]);
      const other = "import { buildInitialWorld } from '@opensamguk/rules';\nexport { buildInitialWorld };\n";
      expect(await ruleIds(other, file), file).toContain('no-restricted-imports');
    }
    for (const file of [
      'apps/web/src/battleSim/request.ts',
      'apps/web/src/battleSim/battle.worker.ts',
      'apps/web/src/battleSim/BattleSimPage.tsx',
      'apps/web/src/x.ts',
    ]) {
      expect(await ruleIds(rulesValue, file), file).toContain('no-restricted-imports');
    }
  });

  it('E1 파일도 shared/node·engine·db·server 값과 node 내장 모듈은 막힌다', async () => {
    const file = 'apps/web/src/battleSim/compute.ts';
    for (const code of [
      "export * from '@opensamguk/shared/node';\n",
      "import { x } from '@opensamguk/engine';\nexport { x };\n",
      "import { createDb } from '@opensamguk/db';\nexport { createDb };\n",
      "import { appRouter } from '@opensamguk/server/router';\nexport { appRouter };\n",
      "import * as fs from 'node:fs';\nexport { fs };\n",
    ]) {
      expect(await ruleIds(code, file), code).toContain('no-restricted-imports');
    }
  });

  it('E2: publicUnitSet.ts만 basic.json 하나를 상대 경로로 읽는다', async () => {
    expect(await ruleIds(unitSetJson, 'apps/web/src/battleSim/publicUnitSet.ts')).toEqual([]);
    const otherJson = "import map from '../../../../resources/map/che.json';\nexport { map };\n";
    expect(await ruleIds(otherJson, 'apps/web/src/battleSim/publicUnitSet.ts')).toContain('no-restricted-imports');
    expect(await ruleIds(rulesValue, 'apps/web/src/battleSim/publicUnitSet.ts')).toContain('no-restricted-imports');
    for (const file of ['apps/web/src/battleSim/request.ts', 'apps/web/src/battleSim/compute.ts']) {
      expect(await ruleIds(unitSetJson, file), file).toContain('opensamguk/no-cross-package-relative');
    }
    expect(
      await ruleIds(
        "import basic from '../../../resources/unitset/basic.json';\nexport { basic };\n",
        'apps/web/src/x.ts',
      ),
    ).toContain('opensamguk/no-cross-package-relative');
  });
});
