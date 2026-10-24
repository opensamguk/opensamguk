import { describe, expect, it } from 'vitest';
import map from '../resources/map/che.json';
import scenario from '../resources/scenario/1030.json';
import unitSet from '../resources/unitset/basic.json';
import statRules from '../resources/scenario/default.json';
import portraitMap from '../resources/portraits/rtk14-map.json';
import { buildInitialWorld } from '../packages/rules/src/index';
import {
  normalizeMapToV2,
  validateMap,
  validateResource,
  validateScenario,
  validateUnitSet,
  type ResourceKind,
} from '../packages/rules/src/world/validate/index';
import { hashState } from '../packages/shared/src/node/hashState';
import { resourceHash } from '../apps/engine/src/replay';

const input = { map, scenario, unitSet, statRules, portraitMap, seed: 'resource-validation' };

describe('AC-P2-27 내장 자원과 월드 생성 대응', () => {
  it.each([
    ['MAP', map],
    ['UNIT_SET', unitSet],
    ['STAT_RULES', statRules],
    ['PORTRAIT_MAP', portraitMap],
  ] as Array<[ResourceKind, unknown]>)('%s 내장 판은 오류·경고 없이 통과한다', (kind, content) => {
    expect(validateResource(kind, content)).toMatchObject({ ok: true, issues: [] });
  });
  it('che 도시 94개와 1030의 기존 외교 중복 경고 하나를 확인한다', () => {
    expect(validateMap(map).value?.cities).toHaveLength(94);
    const result = validateScenario(scenario, { map });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'scenario-diplomacy-duplicate',
        severity: 'warning',
        target: { kind: 'diplomacy', index: 3 },
      }),
    ]);
  });
  it('v1 복제·빈 지형·해안 추가 모두 초기 상태와 두 해시를 보존한다', () => {
    const v2 = normalizeMapToV2(validateMap(map).value!);
    expect(v2.$comment).toBe(map.$comment);
    expect(v2.defaults).toEqual(map.defaults);
    expect(v2.canvas).toEqual({ width: 700, height: 500 });
    expect(v2.cities).toHaveLength(94);
    expect(v2.terrain).toEqual({ coast: [], lakes: [], mountains: [], rivers: [] });
    const original = buildInitialWorld(input);
    for (const terrain of [
      v2.terrain,
      {
        ...v2.terrain,
        coast: [
          [
            [0, 0],
            [700, 0],
            [700, 500],
            [0, 500],
            [0, 0],
          ],
        ],
      },
    ]) {
      const converted = { ...v2, terrain };
      expect(validateMap(converted)).toMatchObject({ ok: true, issues: [] });
      const result = buildInitialWorld({ ...input, map: converted });
      expect(result).toEqual(original);
      expect(hashState(result)).toBe(hashState(original));
      expect(resourceHash(result)).toBe(resourceHash(original));
    }
  });

  const mapCases: Array<[string, (m: typeof map) => void]> = [
    [
      '도시 ID 중복',
      (m) => {
        m.cities[1]!.id = m.cities[0]!.id;
      },
    ],
    [
      '도시 이름 중복',
      (m) => {
        m.cities[1]!.name = m.cities[0]!.name;
      },
    ],
    [
      '연결 중복',
      (m) => {
        m.cities[0]!.connections.push(m.cities[0]!.connections[0]!);
      },
    ],
    [
      '자기 연결',
      (m) => {
        m.cities[0]!.connections.push(m.cities[0]!.id);
      },
    ],
    [
      '없는 연결 도시',
      (m) => {
        m.cities[0]!.connections.push(999);
      },
    ],
    [
      '한쪽 연결',
      (m) => {
        m.cities[0]!.connections.pop();
      },
    ],
    ...(['population', 'agriculture', 'commerce', 'security', 'defence', 'wall'] as const).map(
      (field): [string, (m: typeof map) => void] => [
        `초기값 ${field}`,
        (m) => {
          m.cities[0]!.initial[field] = m.cities[0]!.max[field] + 1;
        },
      ],
    ),
  ];
  it.each(mapCases)('월드 생성의 %s 거부를 검증기도 오류로 잡는다', (_, change) => {
    const changed = structuredClone(map);
    change(changed);
    expect(() => buildInitialWorld({ ...input, map: changed })).toThrow();
    expect(validateMap(changed).issues.some((i) => i.severity === 'error')).toBe(true);
  });

  const scenarioCases: Array<[string, (s: typeof scenario) => void]> = [
    [
      '없는 국가 도시',
      (s) => {
        (s.nation[0]![8] as string[]).push('없음');
      },
    ],
    [
      '도시 중복 소유',
      (s) => {
        (s.nation[1]![8] as string[]).push((s.nation[0]![8] as string[])[0]!);
      },
    ],
    [
      '같은 국가 안 도시 중복',
      (s) => {
        (s.nation[0]![8] as string[]).push((s.nation[0]![8] as string[])[0]!);
      },
    ],
    [
      '장수 국가',
      (s) => {
        s.general[0]![3] = 999;
      },
    ],
    [
      '장수 생몰년',
      (s) => {
        s.general[0]![9] = Number(s.general[0]![10]) + 1;
      },
    ],
    [
      '장수 도시',
      (s) => {
        s.general[0]![4] = '없음';
      },
    ],
    [
      '같은 국가 외교',
      (s) => {
        s.diplomacy = [[1, 1, 0, 0]];
      },
    ],
    [
      '없는 국가 외교',
      (s) => {
        s.diplomacy = [[1, 999, 0, 0]];
      },
    ],
  ];
  it.each(scenarioCases)('월드 생성의 %s 거부를 검증기도 오류로 잡는다', (_, change) => {
    const changed = structuredClone(scenario);
    change(changed);
    expect(() => buildInitialWorld({ ...input, scenario: changed })).toThrow();
    expect(validateScenario(changed, { map }).issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it.each(['병종 ID 중복', '기본 병종 없음'])('월드 생성의 %s 거부를 검증기도 오류로 잡는다', (name) => {
    const changed = structuredClone(unitSet);
    if (name === '병종 ID 중복') changed.crewTypes[2]!.id = changed.crewTypes[1]!.id;
    else changed.defaultCrewTypeId = 9999;
    expect(() => buildInitialWorld({ ...input, unitSet: changed })).toThrow();
    expect(validateUnitSet(changed).issues.some((i) => i.severity === 'error')).toBe(true);
  });
});
