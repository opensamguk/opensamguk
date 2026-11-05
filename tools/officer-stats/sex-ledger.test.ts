import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadSexLedger, loadSexLedgers } from '../../apps/engine/src/world/resources';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
it('AC-P2-32 검토된 성별 사실 해시와 191년 시나리오의 인물 대응을 대조한다', () => {
  const ledgers = loadSexLedgers(),
    identities = read('resources/officers/191-five-stats.json').rows;
  for (const ledger of ledgers)
    for (const row of ledger.rows) {
      expect(identities.find((person: { generalId: number }) => person.generalId === row.generalId)).toMatchObject({
        name: row.name,
        identity: row.identity,
      });
      for (const key of ledger.scenarios)
        expect(read(`resources/scenario/${key}.json`).general[row.generalId - 1][1]).toBe(row.name);
    }
  expect(ledgers[0]!.rows.map((row) => [row.generalId, row.sex])).toEqual([
    [108, 'MALE'],
    [439, 'FEMALE'],
  ]);
  expect(loadSexLedger().rows.map((row) => [row.generalId, row.sex])).toEqual([
    [108, 'MALE'],
    [439, 'FEMALE'],
    [47, 'MALE'],
    [281, 'MALE'],
    [322, 'MALE'],
    [314, 'MALE'],
    [318, 'MALE'],
    [321, 'MALE'],
    [229, 'MALE'],
    [167, 'MALE'],
    [169, 'MALE'],
    [381, 'MALE'],
    [394, 'MALE'],
    [385, 'MALE'],
    [266, 'MALE'],
    [271, 'MALE'],
    [267, 'MALE'],
    [276, 'MALE'],
    [291, 'MALE'],
    [100, 'MALE'],
    [103, 'MALE'],
    [99, 'MALE'],
    [93, 'MALE'],
  ]);
});

it('AC-P2-32 기존 판의 바이트와 뒤 판의 기존 사실을 보존한다', () => {
  expect(
    createHash('sha256')
      .update(readFileSync(new URL('../../resources/officers/191-sex.json', import.meta.url)))
      .digest('hex'),
  ).toBe('d5179cf98ffe03a7f3a910642d9e15ef5d52825a6e8dddb2415052f251d2ddb4');
  expect(
    createHash('sha256')
      .update(readFileSync(new URL('../../resources/officers/191-sex-2.json', import.meta.url)))
      .digest('hex'),
  ).toBe('8c468b4cf34e5c2f8b90bced624a88bf7c8751ef4754aed528b8edcc64b40ab8');
  const ledgers = loadSexLedgers();
  expect(ledgers).toHaveLength(3);
  expect(ledgers.map((ledger) => ledger.review.contentSha256)).toEqual([
    '56185bc5c826551be6717b4021db62b6ef42355c6e1e6742005d122888fbb519',
    '4b63c4842f0b41d81fe4b8ba6df25dbaec4cc083b8c30f1a2f3c126c2b23e847',
    '1545771f0b042645b9cb4f3f1496672deb16efaa76c02b3b252afd705a215761',
  ]);
  for (let index = 1; index < ledgers.length; index++) {
    const previous = ledgers[index - 1]!,
      next = ledgers[index]!;
    expect(next.scenarios).toEqual(expect.arrayContaining(previous.scenarios));
    for (const row of previous.rows) expect(next.rows.find((item) => item.generalId === row.generalId)).toEqual(row);
  }
});
