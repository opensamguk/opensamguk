import { readFile } from 'node:fs/promises';
import { buildInitialWorld } from '@opensamguk/rules';

export const resourceRoot = new URL('../../../../resources/', import.meta.url);

function resourceKey(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('리소스 ID는 영문·숫자·밑줄·하이픈만 허용합니다.');
  return value;
}

export async function loadInitialWorld(options: {
  scenario: string; map: string; seed: string; unitSet?: string;
}) {
  const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, resourceRoot), 'utf8'));
  const [map, scenario, unitSet, statRules] = await Promise.all([
    readJson(`map/${resourceKey(options.map)}.json`),
    readJson(`scenario/${resourceKey(options.scenario)}.json`),
    readJson(`unitset/${resourceKey(options.unitSet ?? 'basic')}.json`),
    readJson('scenario/default.json'),
  ]);
  return buildInitialWorld({ map, scenario, unitSet, statRules, seed: options.seed });
}
