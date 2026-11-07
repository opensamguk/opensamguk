import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadSexLedgers } from '../../apps/engine/src/world/resources';

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
