import { readFile } from 'node:fs/promises';
import type { readPublishedResources, GameResourceKind, PublishedResource } from '@opensamguk/db';
import { buildInitialWorld, parsePreset, type WorldInit } from '@opensamguk/rules';

export const resourceRoot = new URL('../../../../resources/', import.meta.url);
export interface WorldResourceSelection {
  scenario: string;
  map: string;
  unitSet?: string;
  statRules?: string;
  portraitMap?: string;
}

function resourceKey(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('리소스 ID는 영문·숫자·밑줄·하이픈만 허용합니다.');
  return value;
}

export async function loadPreset(key: string, root: URL = resourceRoot) {
  return parsePreset(JSON.parse(await readFile(new URL(`preset/${resourceKey(key)}.json`, root), 'utf8')));
}

// 새 지도 기본값을 생성·CLI·재생 원본 추론이 함께 쓴다. 명시한 판 선택은 그대로 유지한다.
export function resolveWorldResourceSelection(options: WorldResourceSelection): Required<WorldResourceSelection> {
  return {
    scenario: resourceKey(options.scenario),
    map: resourceKey(options.map),
    unitSet: resourceKey(options.unitSet ?? 'basic'),
    statRules: resourceKey(options.statRules ?? (options.map === 'san10' ? 'five-stats' : 'default')),
    portraitMap: resourceKey(options.portraitMap ?? (options.map === 'san10' ? '191-map' : 'rtk14-map')),
  };
}

export async function loadInitialWorld(options: WorldResourceSelection & { seed: string }, root: URL = resourceRoot) {
  const selected = resolveWorldResourceSelection(options);
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, root), 'utf8'));
  const [map, scenario, unitSet, statRules, portraitMap] = await Promise.all([
    readJson(`map/${selected.map}.json`),
    readJson(`scenario/${selected.scenario}.json`),
    readJson(`unitset/${selected.unitSet}.json`),
    readJson(`scenario/${selected.statRules}.json`),
    readJson(`portraits/${selected.portraitMap}.json`),
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
  options: WorldResourceSelection,
): Promise<InitialResources> {
  const selected = resolveWorldResourceSelection(options);
  const { readPublishedResources } = await import('@opensamguk/db');
  const [map, scenario, unitSet, statRules, portraitMap] = await readPublishedResources(db, [
    { kind: 'MAP', name: selected.map, version: 1 },
    { kind: 'SCENARIO', name: selected.scenario, version: 1 },
    { kind: 'UNIT_SET', name: selected.unitSet, version: 1 },
    { kind: 'STAT_RULES', name: selected.statRules, version: 1 },
    { kind: 'PORTRAIT_MAP', name: selected.portraitMap, version: 1 },
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
  options: WorldResourceSelection & { seed: string },
): Promise<WorldInit> {
  return composeInitialWorld(await readInitialResources(db, options), options.seed);
}
