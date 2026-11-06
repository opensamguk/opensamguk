import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { PublishedResource } from '@opensamguk/db';
import { hashState } from '@opensamguk/shared/node';
import {
  composeInitialWorld,
  loadInitialWorld,
  resolveWorldResourceSelection,
  type InitialResources,
} from './resources';

const selection = {
  map: 'integration',
  scenario: 'integration191',
  unitSet: 'basic',
  statRules: 'five-stats',
  portraitMap: '191-map',
};
function resource(kind: PublishedResource['kind'], name: string, path: string): PublishedResource {
  const content: unknown = JSON.parse(
    readFileSync(new URL(`../../../../resources/${path}.json`, import.meta.url), 'utf8'),
  );
  return { kind, name, version: 1, content, contentHash: hashState(content), source: 'repository' };
}
const resources: InitialResources = {
  map: resource('MAP', 'integration', 'map/integration'),
  scenario: resource('SCENARIO', 'integration191', 'scenario/integration191'),
  unitSet: resource('UNIT_SET', 'basic', 'unitset/basic'),
  statRules: resource('STAT_RULES', 'five-stats', 'scenario/five-stats'),
  portraitMap: resource('PORTRAIT_MAP', '191-map', 'portraits/191-map'),
};

it('AC-P2-27 1판 별칭은 기존 파일·합성 결과와 해시가 같다', async () => {
  const plain = await loadInitialWorld({ ...selection, seed: 'resource-version' });
  const alias = Object.fromEntries(
    Object.entries(selection).map(([slot, key]) => [slot, `${key}@1`]),
  ) as typeof selection;
  expect(await loadInitialWorld({ ...alias, seed: 'resource-version' })).toEqual(plain);
  expect(hashState(composeInitialWorld(resources, 'resource-version'))).toBe(hashState(plain));
});

it('AC-P2-27 2판 합성은 내용 id를 보존하고 월드의 세 키만 정규형으로 고정한다', () => {
  const next = structuredClone(resources);
  for (const row of Object.values(next)) row.version = 2;
  const plain = composeInitialWorld(resources, 'resource-version');
  expect(composeInitialWorld(next, 'resource-version')).toEqual({
    ...plain,
    mapKey: 'integration@2',
    scenarioKey: 'integration191@2',
    unitSetKey: 'basic@2',
  });
  expect(next.unitSet.content).toEqual(resources.unitSet.content);
});

it('AC-P2-27 파일 경계는 2판을 파일 읽기 전에 거부한다', async () => {
  await expect(
    loadInitialWorld({ ...selection, map: 'integration@2', seed: 'resource-version' }, new URL('file:///nonexistent/')),
  ).rejects.toThrow('게시된 판으로 생성하세요');
  expect(resolveWorldResourceSelection({ map: 'san10@2', scenario: 'san10-191@2' })).toEqual({
    map: 'san10@2',
    scenario: 'san10-191@2',
    unitSet: 'basic',
    statRules: 'five-stats',
    portraitMap: '191-map',
  });
});
