import { readFile } from 'node:fs/promises';
import type { WorldInit } from '@opensamguk/rules';

export async function warFixture(): Promise<WorldInit> {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/war-initial.json', import.meta.url), 'utf8')) as {
    initial: WorldInit;
  };
  return {
    ...fixture.initial,
    scenarioKey: 'engine-war-fixture',
    cityScale: { cities: [] },
    statRules: { count: 5, total: 275, min: 15, max: 90 },
    generals: fixture.initial.generals.map((general) => ({
      ...general,
      crew: 0,
      politics: 50,
      charm: 50,
      sex: 'UNKNOWN',
    })),
  };
}
