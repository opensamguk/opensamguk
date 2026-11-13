import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadSexLedgers } from '../../apps/engine/src/world/resources';
import { applySexLedger } from '../../packages/rules/src/general/sex';

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
  expect(
    createHash('sha256')
      .update(readFileSync(new URL('../../resources/officers/191-sex-3.json', import.meta.url)))
      .digest('hex'),
  ).toBe('be9f1f57ca12530a06235c12ed1d258797e98f2d7fdf7218e0fc9425fdddcb0c');
  const ledgers = loadSexLedgers();
  expect(ledgers).toHaveLength(4);
  expect(ledgers.map((ledger) => ledger.review.contentSha256)).toEqual([
    '56185bc5c826551be6717b4021db62b6ef42355c6e1e6742005d122888fbb519',
    '4b63c4842f0b41d81fe4b8ba6df25dbaec4cc083b8c30f1a2f3c126c2b23e847',
    '1545771f0b042645b9cb4f3f1496672deb16efaa76c02b3b252afd705a215761',
    '7e9c0bfbb1d0e2997264f100246ebcbd892ec9a525b772376eeae8a890f78c2d',
  ]);
  for (let index = 1; index < ledgers.length; index++) {
    const previous = ledgers[index - 1]!,
      next = ledgers[index]!;
    expect(next.scenarios).toEqual(expect.arrayContaining(previous.scenarios));
    for (const row of previous.rows) expect(next.rows.find((item) => item.generalId === row.generalId)).toEqual(row);
  }
});

it('AC-P2-32 검수된 삼10 191년 두 판에만 기존 인물 사실을 적용한다', () => {
  const ledgers = loadSexLedgers(),
    ledger = ledgers.at(-1)!;
  expect(ledger.rows).toEqual(ledgers[2]!.rows);
  for (const [file, key] of [
    ['san10-191.json', 'san10-191'],
    ['san10-191-v2.json', 'san10-191@2'],
  ] as const) {
    const scenario = JSON.parse(readFileSync(new URL('../../resources/scenario/' + file, import.meta.url), 'utf8')) as {
      general: Array<[number, string]>;
    };
    const generals = scenario.general.map(([, name], index) => ({ id: index + 1, name }));
    const applied = applySexLedger({ scenarioKey: key, generals }, ledger);
    expect(applied.filter((general) => general.sex !== 'UNKNOWN')).toHaveLength(23);
    expect(
      applySexLedger({ scenarioKey: key, generals }, ledgers[2]!).every((general) => general.sex === 'UNKNOWN'),
    ).toBe(true);
    expect(
      applySexLedger({ scenarioKey: 'san10-191@3', generals }, ledger).every((general) => general.sex === 'UNKNOWN'),
    ).toBe(true);
  }
});
