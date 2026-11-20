import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([
  'tacticalBattle',
  'cityResourceInput',
  'governance/input',
  'lineage/input',
  'logistics/input',
  'proposalRecord',
  'stratagemCards/input',
  'entryInput',
])('AC-INT-27 %s부터 읽어도 순환 import 등록표가 초기화된다', (name) => {
  // 모듈 캐시가 초기화 순서 결함을 가리지 않도록 파일마다 새 프로세스에서 읽는다.
  const url = new URL(`../apps/engine/src/${name}.ts`, import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
