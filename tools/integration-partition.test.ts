import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_INTEGRATION_FILES, integrationPartition } from './integration-partition';

async function integrationFiles() {
  return (
    await Promise.all(
      ['apps', 'tools'].map(async (directory) =>
        (await readdir(new URL(`../${directory}/`, import.meta.url), { recursive: true })).map(
          (file) => `${directory}/${file}`,
        ),
      ),
    )
  )
    .flat()
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => /^(apps\/.*|tools\/[^/]+)\.integration\.test\.ts$/.test(file))
    .sort();
}

function partition(files: string[]) {
  const engine = integrationPartition('engine');
  const excluded = new Set(engine);
  return { engine, api: files.filter((file) => !excluded.has(file)) };
}

function recordsAuthz(source: string) {
  const parsed = ts.createSourceFile('integration.test.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const recorderModule = (node: ts.Node | undefined) =>
    node && ts.isStringLiteral(node) && /\/authz\/case(?:\.[cm]?[jt]s)?$/.test(node.text);
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) && recorderModule(node.moduleSpecifier)) ||
      (ts.isExportDeclaration(node) && recorderModule(node.moduleSpecifier)) ||
      (ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'authzCase') ||
          (recorderModule(node.arguments[0]) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require')))))
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

describe('INT-01 / AC-INT-01 PostgreSQL CI 분할', () => {
  let files: string[];
  beforeAll(async () => {
    files = await integrationFiles();
  });

  it('기본은 전체이며 잘못된 묶음은 DB 접속 전에 거부한다', () => {
    expect(integrationPartition(undefined)).toEqual([]);
    expect(integrationPartition('all')).toEqual([]);
    for (const value of ['', 'API', 'other', 'api,engine'])
      expect(() => integrationPartition(value)).toThrow('INTEGRATION_SUITE');
  });

  it('실제 통합 파일은 두 CI 묶음에 빠짐없이 한 번씩 속한다', () => {
    const { engine, api } = partition(files);
    const apiArgs = integrationPartition('api');
    expect(apiArgs).toHaveLength(engine.length * 2);
    for (const [index, file] of engine.entries())
      expect(apiArgs.slice(index * 2, index * 2 + 2)).toEqual(['--exclude', file]);
    expect(new Set(engine).size).toBe(engine.length);
    for (const file of engine) expect(files).toContain(file);
    expect(api.filter((file) => engine.includes(file))).toEqual([]);
    expect([...api, ...engine].sort()).toEqual(files);
    expect(new Set([...api, ...engine]).size).toBe(files.length);
    expect(api).toContain('tools/int06-campaign.integration.test.ts');
  });

  it('기존 다섯 파일과 승인한 일곱 파일만 엔진 묶음에 넣는다', () => {
    expect(ENGINE_INTEGRATION_FILES).toEqual([
      'tools/scenarios.integration.test.ts',
      'apps/engine/src/supervisor.integration.test.ts',
      'apps/engine/src/accelerated.integration.test.ts',
      'apps/engine/src/season.integration.test.ts',
      'apps/engine/src/lease.integration.test.ts',
      'tools/int18-city-resources.integration.test.ts',
      'tools/integration-scenario.integration.test.ts',
      'tools/resource-catalog.integration.test.ts',
      'tools/t4-17-ext-n2.integration.test.ts',
      'tools/preset.integration.test.ts',
      'tools/t1-11.integration.test.ts',
      'tools/t4-03-cap6-central.integration.test.ts',
    ]);
  });

  it('모든 직접 권한 기록 파일은 전역 대조를 실행하는 API 묶음에 남긴다', async () => {
    const { engine, api } = partition(files);
    const recorders: string[] = [];
    for (const file of files) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      if (!recordsAuthz(source)) continue;
      recorders.push(file);
      expect(api, file).toContain(file);
      expect(engine, file).not.toContain(file);
    }
    expect(recorders.length).toBeGreaterThan(0);
    expect(recorders).toContain('tools/int06-campaign.integration.test.ts');
    expect(recorders).toContain('tools/authz.integration.test.ts');
  });

  it('권한 기록의 별칭·namespace·동적 import도 찾고 주석과 문자열은 구분한다', () => {
    for (const source of [
      'authzCase("world.list", "success", run);',
      'import { authzCase as record } from "../apps/server/src/authz/case"; record("world.list", "success", run);',
      'import * as records from "../apps/server/src/authz/case.js"; records.authzCase("world.list", "success", run);',
      'const { authzCase: record } = await import("../apps/server/src/authz/case");',
      'const records = require("../apps/server/src/authz/case");',
    ])
      expect(recordsAuthz(source), source).toBe(true);
    expect(recordsAuthz('// authzCase("world.list", "success", run);')).toBe(false);
    expect(recordsAuthz('const description = "authzCase()";')).toBe(false);
  });

  it('T2-15 복원 검사는 입력 바인딩과 정리를 갖춘 API 묶음에 남긴다', () => {
    const { engine, api } = partition(files);
    expect(api).toContain('tools/t2-15-restore.integration.test.ts');
    expect(engine).not.toContain('tools/t2-15-restore.integration.test.ts');
  });
});
