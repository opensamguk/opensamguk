import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInitialWorld } from '../packages/rules/src/index';
import type { ScenarioResource } from '../packages/rules/src/world/resources';
import { readInitialResources } from '../apps/engine/src/world/resources';
import { matchPortraits, parseRegistry } from './portrait-map/convert';
import { createDb } from '../packages/db/src/index';
import { testDatabaseUrl } from './test-database';

const selectedResources = await (async () => {
  const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
  try {
    return await readInitialResources(db, { map: 'che', scenario: '1030' });
  } finally {
    await db.$disconnect();
  }
})();

const readings = JSON.parse(readFileSync(new URL('portrait-map/hanja-readings.json', import.meta.url), 'utf8'))
  .readings as Record<string, string>;
const registry = parseRegistry(readFileSync(new URL('portrait-map/registry.tsv', import.meta.url), 'utf8'));
const input = {
  map: selectedResources.map.content,
  scenario: selectedResources.scenario.content as ScenarioResource,
  unitSet: selectedResources.unitSet.content,
  statRules: selectedResources.statRules.content,
  seed: 'portraits',
};
describe('AC-M1-20 초상 이름 대응', () => {
  it('고정된 생성물이 재생성 결과와 같고 월드에 429/491명을 안전하게 붙인다', () => {
    const expected = selectedResources.portraitMap.content as Record<string, unknown>;
    const generated = matchPortraits(
      input.scenario.general.map((row) => row[1]),
      registry,
      readings,
    );
    expect({ ...expected, $comment: undefined }).toEqual({ ...generated, $comment: undefined });
    expect(generated.stats).toEqual({ matched: 429, total: 491, percent: 87.37 });
    const state = buildInitialWorld({ ...input, portraitMap: expected });
    expect(state.generals.filter((general) => general.portraitId !== null)).toHaveLength(429);
    expect(state.generals.find((general) => general.name === '유비')?.portraitId).toBe(10071);
    expect(state.generals.find((general) => general.name === '고승')?.portraitId).toBeNull();
    expect(state.generals.find((general) => general.name === '헌제')?.portraitId).toBeNull();
    expect(() => buildInitialWorld({ ...input, portraitMap: { portraits: { 조조: 1 } } })).toThrow();
  });
});
