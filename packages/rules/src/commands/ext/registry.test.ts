import { expect, it } from 'vitest';
import { commands } from '../registry';
import { extensionCommands } from './registry';
import { extCommandBindings, extSlices, type ExtStateRegistry } from './state';
import type { CommandDef } from '../types';

function verifyCatalog(
  extensions: readonly CommandDef[],
  bindings: ExtStateRegistry['bindings'],
  testedKeys: readonly string[],
) {
  const base = new Set(commands.map((def) => def.key));
  const keys = extensions.map((def) => def.key);
  expect(keys.some((key) => base.has(key))).toBe(false);
  expect(new Set(keys).size).toBe(keys.length);
  expect(bindings).toHaveLength(extensions.length);
  expect(new Set(bindings.map((binding) => binding.commandKey)).size).toBe(bindings.length);
  expect(bindings.map(({ commandKey, target }) => [commandKey, target]).sort()).toEqual(
    extensions.map(({ key, target }) => [key, target]).sort(),
  );
  expect([...testedKeys].sort()).toEqual([...keys].sort());
}

it('운영 확장 목록·조각·관계는 비어 있고 기본 37개와 분리된다', () => {
  expect(extensionCommands).toEqual([]);
  expect(extSlices).toEqual([]);
  expect(extCommandBindings).toEqual([]);
  verifyCatalog(extensionCommands, extCommandBindings, []);
});

it('관계 누락·남는 관계·대상 불일치·중복·기본 충돌·시험 누락을 검출한다', () => {
  const extension = { ...commands[0]!, key: 't_a' };
  const binding = { commandKey: 't_a', target: 'general' as const, sliceKeys: [] };
  verifyCatalog([extension], [binding], ['t_a']);
  expect(() => verifyCatalog([extension], [], ['t_a'])).toThrow();
  expect(() => verifyCatalog([], [binding], [])).toThrow();
  expect(() => verifyCatalog([extension], [{ ...binding, target: 'nation' }], ['t_a'])).toThrow();
  expect(() => verifyCatalog([extension, extension], [binding, binding], ['t_a', 't_a'])).toThrow();
  expect(() =>
    verifyCatalog([commands[0]!], [{ ...binding, commandKey: commands[0]!.key }], [commands[0]!.key]),
  ).toThrow();
  expect(() => verifyCatalog([extension], [binding], [])).toThrow();
});
