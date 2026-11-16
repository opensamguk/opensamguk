import { providedRuleKeys } from '@opensamguk/rules';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { artifactCreationProfiles } from './worldCreateOptions';

const read = async (path: string) =>
  JSON.parse(await readFile(new URL(`../../../../resources/${path}`, import.meta.url), 'utf8'));

it.each([1, 3])('AC-INT-27·28 확장 지도 %i판과 같은 시나리오 판·기능·앵커 수를 안내한다', async (edition) => {
  const categories = await read('scenario/san10-expanded-categories.json');
  const tx = {
    gameResource: {
      findFirst: vi.fn(async () => ({ version: edition })),
      findMany: vi.fn(async () => [
        { kind: 'MAP', name: 'san10-expanded', version: edition, contentHash: 'map' },
        { kind: 'UNIT_SET', name: 'expanded', version: 1, contentHash: 'units' },
        { kind: 'STAT_RULES', name: 'five-stats', version: 1, contentHash: 'stats' },
        { kind: 'PORTRAIT_MAP', name: 'san10-expanded-portraits', version: 1, contentHash: 'portraits' },
      ]),
    },
    $queryRaw: vi.fn(async () =>
      Object.keys(categories).map((name) => ({
        name,
        title: name,
        year: 191,
        generals: 10,
        nations: 2,
        contentHash: name,
      })),
    ),
  };
  const profiles = await artifactCreationProfiles(tx as unknown as Parameters<typeof artifactCreationProfiles>[0], [
    { key: 'regular', value: await read('preset/regular.json') },
    { key: 'empty', value: await read('preset/empty.json') },
  ]);
  expect(profiles).toHaveLength(91);
  const profile = profiles![0]!;
  if (!profile.available) throw Error('게시 판이 필요합니다.');
  expect(profile.selection.mapKey).toBe(edition === 3 ? 'san10-expanded@3' : 'san10-expanded');
  expect(profile.selection.scenarioKey).toBe(`${profile.id}${edition === 3 ? '@3' : ''}`);
  expect(providedRuleKeys.includes('capturable-field-v1')).toBe(edition === 3);
  expect(profile.counts.anchors).toBe(edition === 3 ? 195 : 322);
});
