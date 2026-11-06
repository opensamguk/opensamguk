import { describe, expect, it } from 'vitest';
import { buildInitialWorld, type WorldInit } from '../packages/rules/src/world/bootstrap';
import { hashState } from '../packages/shared/src/node/hashState';
import {
  normalizeMapToV2,
  validateMap,
  validateScenario,
  validateWorldResources,
} from '../packages/rules/src/world/validate/index';
import { createDb } from '../packages/db/src/index';
import type { MapResource, ScenarioResource, UnitSetResource } from '../packages/rules/src/world/resources';
import { readInitialResources } from '../apps/engine/src/world/resources';
import { testDatabaseUrl } from './test-database';

// 게시된 원문을 그대로 대조한다. schema parse로 meta 등 검증 대상 속성을 지우지 않는다.
const resources = await (async () => {
  const db = createDb(testDatabaseUrl({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }).href);
  try {
    return await readInitialResources(db, { map: 'che', scenario: '1030' });
  } finally {
    await db.$disconnect();
  }
})();
const map = resources.map.content as MapResource & { $comment?: unknown };
const scenario = resources.scenario.content as ScenarioResource;
const unitSet = resources.unitSet.content as UnitSetResource;
const statRules = resources.statRules.content;
const portraitMap = resources.portraitMap.content;

// 바꾸지 않는 engine 모듈을 실제로 호출한다. 도구 타입 검사의 범위는 새 파일과 rules다.
const replayModule = '../apps/engine/src/replay';
const { resourceHash } = (await import(replayModule)) as { resourceHash: (initial: WorldInit) => string };

const input = { map, scenario, unitSet, statRules, portraitMap, seed: 't4-76-che' };
describe('T4-76 실제 내장 자원과 기존 생성 함수', () => {
  it('다섯 내장 파일과 기존 외교 중복을 실제로 검사한다', () => {
    const result = validateWorldResources(input);
    expect(result.status).toBe('pass');
    expect(result.map.issues).toEqual([]);
    expect(result.scenario.issues.map((item) => [item.code, item.target])).toEqual([
      ['scenario-diplomacy-duplicate', { kind: 'diplomacy', index: 3 }],
    ]);
    expect(result.unitSet.issues).toEqual([]);
    expect(result.statRules.issues).toEqual([]);
    expect(result.portraitMap.issues).toEqual([]);
    expect(validateMap(map).status).toBe('incomplete');
    expect(validateMap(map, { scenarios: [scenario] }).status).toBe('pass');
    expect(validateScenario(scenario, { map }).status).toBe('pass');
  });
  it('v1·빈 지형 v2·지형 있는 v2의 초기 상태와 실제 5키 resourceHash가 같다', () => {
    const normalized = normalizeMapToV2(map);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.map.cities).toHaveLength(94);
    expect(normalized.map.defaults).toMatchObject({ trade: 100, frontState: 0 });
    expect(normalized.map.$comment).toBe(map.$comment);
    expect(normalized.dropped).toContain('meta');
    const v1 = buildInitialWorld(input);
    const v2 = buildInitialWorld({ ...input, map: normalized.map });
    const terrain = structuredClone(normalized.map);
    terrain.terrain.coast.push([
      [0, 0],
      [700, 0],
      [700, 500],
      [0, 0],
    ]);
    const displayed = buildInitialWorld({ ...input, map: terrain });
    expect(v2).toEqual(v1);
    expect(displayed).toEqual(v1);
    expect(hashState(v2)).toBe(hashState(v1));
    expect(hashState(displayed)).toBe(hashState(v1));
    expect(resourceHash(v2)).toBe(resourceHash(v1));
    expect(resourceHash(displayed)).toBe(resourceHash(v1));
    expect(resourceHash(v1)).toBe(
      hashState({
        scenarioKey: v1.scenarioKey,
        mapKey: v1.mapKey,
        unitSetKey: v1.unitSetKey,
        statRules: v1.statRules,
        unitSet: v1.unitSet,
      }),
    );
  });
});
