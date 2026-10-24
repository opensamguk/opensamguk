import { readFile } from 'node:fs/promises';
import type { readPublishedResources, GameResourceKind, PublishedResource } from '@opensamguk/db';
import { buildInitialWorld, parsePreset, type WorldInit } from '@opensamguk/rules';

export const resourceRoot = new URL('../../../../resources/', import.meta.url);

function resourceKey(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('리소스 ID는 영문·숫자·밑줄·하이픈만 허용합니다.');
  return value;
}

export async function loadPreset(key: string, root: URL = resourceRoot) {
  return parsePreset(JSON.parse(await readFile(new URL(`preset/${resourceKey(key)}.json`, root), 'utf8')));
}

export async function loadInitialWorld(
  options: { scenario: string; map: string; seed: string; unitSet?: string },
  root: URL = resourceRoot,
) {
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, root), 'utf8'));
  const [map, scenario, unitSet, statRules, portraitMap] = await Promise.all([
    readJson(`map/${resourceKey(options.map)}.json`),
    readJson(`scenario/${resourceKey(options.scenario)}.json`),
    readJson(`unitset/${resourceKey(options.unitSet ?? 'basic')}.json`),
    readJson('scenario/default.json'),
    readJson('portraits/rtk14-map.json'),
  ]);
  return buildInitialWorld({ map, scenario, unitSet, statRules, portraitMap, seed: options.seed });
}

export interface InitialResources {
  map: PublishedResource;
  scenario: PublishedResource;
  unitSet: PublishedResource;
  statRules: PublishedResource;
  portraitMap: PublishedResource;
}

export async function readInitialResources(
  db: Parameters<typeof readPublishedResources>[0],
  options: { scenario: string; map: string; unitSet?: string },
): Promise<InitialResources> {
  resourceKey(options.scenario);
  resourceKey(options.map);
  resourceKey(options.unitSet ?? 'basic');
  const { readPublishedResources } = await import('@opensamguk/db');
  const [map, scenario, unitSet, statRules, portraitMap] = await readPublishedResources(db, [
    { kind: 'MAP', name: options.map, version: 1 },
    { kind: 'SCENARIO', name: options.scenario, version: 1 },
    { kind: 'UNIT_SET', name: options.unitSet ?? 'basic', version: 1 },
    { kind: 'STAT_RULES', name: 'default', version: 1 },
    { kind: 'PORTRAIT_MAP', name: 'rtk14-map', version: 1 },
  ]);
  return { map: map!, scenario: scenario!, unitSet: unitSet!, statRules: statRules!, portraitMap: portraitMap! };
}

export function composeInitialWorld(resources: InitialResources, seed: string): WorldInit {
  const kinds: Record<keyof InitialResources, GameResourceKind> = {
    map: 'MAP',
    scenario: 'SCENARIO',
    unitSet: 'UNIT_SET',
    statRules: 'STAT_RULES',
    portraitMap: 'PORTRAIT_MAP',
  };
  const keys: string[] = [];
  for (const slot of Object.keys(kinds) as (keyof InitialResources)[]) {
    const resource = resources[slot];
    const key = `${resource.kind}/${resource.name}/${resource.version}`;
    keys.push(key);
    if (resource.kind !== kinds[slot]) throw new Error(`자원 종류가 칸과 다릅니다: ${key}`);
    if (resource.version !== 1) throw new Error(`초기 월드는 자원 1판만 씁니다: ${key}`);
    if (!/^[a-zA-Z0-9_-]+$/.test(resource.name)) throw new Error(`자원 이름을 확인하세요: ${key}`);
    if (['map', 'scenario', 'unitSet'].includes(slot)) {
      const content = resource.content;
      if (content === null || typeof content !== 'object' || !('id' in content) || content.id !== resource.name) {
        throw new Error(`자원 내용의 id와 이름이 다릅니다: ${key}`);
      }
    }
  }
  try {
    return buildInitialWorld({
      map: resources.map.content,
      scenario: resources.scenario.content,
      unitSet: resources.unitSet.content,
      statRules: resources.statRules.content,
      portraitMap: resources.portraitMap.content,
      seed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '자원 내용을 확인하세요.';
    throw new Error(`자원 합성 실패 (${keys.join(', ')}): ${message}`, { cause: error });
  }
}

export async function loadInitialWorldFromDb(
  db: Parameters<typeof readPublishedResources>[0],
  options: { scenario: string; map: string; seed: string; unitSet?: string },
): Promise<WorldInit> {
  return composeInitialWorld(await readInitialResources(db, options), options.seed);
}
