import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { portraitMapSchema } from '../../packages/rules/src/world/resources';
import ledger from '../../resources/officers/191-five-stats.json';
import map from '../../resources/portraits/191-map.json';
import manifest from '../../resources/portraits/191-supplement.json';
import { parseRegistry } from '../portrait-map/convert';

it('191년 491명의 초상이 독립 검수한 인물 ID와 보충 8명에 대응한다', async () => {
  const portraits = portraitMapSchema.parse(map).portraits;
  const registry = new Map(
    parseRegistry(await readFile(new URL('../portrait-map/registry.tsv', import.meta.url), 'utf8')).map((row) => [
      row.id,
      row,
    ]),
  );
  expect(Object.keys(portraits)).toHaveLength(491);
  expect(manifest.portraits.map((row) => row.id)).toEqual([11001, 11002, 11003, 11004, 11005, 11006, 11007, 11008]);
  for (const row of ledger.rows) {
    const supplement = manifest.portraits.find((portrait) => portrait.generalId === row.generalId);
    expect(portraits[row.name]).toBe(supplement?.id ?? row.officerId);
    if (supplement) {
      expect(supplement.name).toBe(row.name);
      expect(supplement.usage).toBe('development-private-test-only');
      expect(supplement.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(supplement.filename).toMatch(new RegExp(`^${supplement.id}\\.(jpg|png)$`));
    } else expect(registry.has(row.officerId)).toBe(true);
  }
  expect(portraits['심영']).toBe(10527);
  expect(portraits['예형']).toBe(11008);
});
