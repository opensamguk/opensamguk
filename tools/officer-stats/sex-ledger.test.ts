import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadSexLedger } from '../../apps/engine/src/world/resources';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
it('AC-P2-32 검토된 성별 사실 해시와 191년 시나리오의 인물 대응을 대조한다', () => {
  const ledger = loadSexLedger(),
    identities = read('resources/officers/191-five-stats.json').rows;
  for (const row of ledger.rows) {
    expect(identities.find((person: { generalId: number }) => person.generalId === row.generalId)).toMatchObject({
      name: row.name,
      identity: row.identity,
    });
    for (const key of ledger.scenarios)
      expect(read(`resources/scenario/${key}.json`).general[row.generalId - 1][1]).toBe(row.name);
  }
  expect(ledger.rows.map((row) => [row.generalId, row.sex])).toEqual([
    [108, 'MALE'],
    [439, 'FEMALE'],
  ]);
});
