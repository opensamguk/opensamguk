import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readExtensionRegistryKeys } from './command-coverage.mjs';

function registry(source: string, check: (root: string) => void) {
  const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.coverage-materials-'));
  try {
    const directory = join(root, 'packages/rules/src/commands/ext');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'registry.ts'), source);
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('AC-INT-28 건물 키 map과 record·regex 스키마를 명령 정의로 해석하지 않는다', () => {
  registry(
    `import {z} from 'zod';
     const buildings = [{key:'office'}, {key:'market'}];
     const keys = buildings.map(building => building.key);
     const state = z.record(z.string().regex(/^[1-9]\\d*$/), z.array(z.enum(keys)));
     export const extensionCommands = [{key:'fire_attack', target:'general'}];`,
    (root) => expect(readExtensionRegistryKeys(root)).toEqual([{ key: 'fire_attack', target: 'general' }]),
  );
});

it('AC-M1-14 스키마 인자 map 안의 숨은 등록 변경은 계속 거부한다', () => {
  registry(
    `import {z} from 'zod';
     const list = [{key:'fire_attack', target:'general'}];
     const buildings = [{key:'office'}];
     const state = z.enum(buildings.map(building => list.push({key:'hidden', target:'general'})));
     export const extensionCommands = list;`,
    (root) => expect(() => readExtensionRegistryKeys(root)).toThrow('확장 registry'),
  );
});
