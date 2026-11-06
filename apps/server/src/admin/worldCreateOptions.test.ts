import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashState } from '@opensamguk/shared/node';
import { featureProfileSchema, ruleRegistry, type RuleRegistry } from '@opensamguk/rules';
import {
  creationFeatures,
  creationProfile,
  creationRefs,
  creationSelection,
  expandedCreationProfile,
  creationOptionsInput,
} from './worldCreateOptions';

const root = new URL('../../../../', import.meta.url);
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const paths = [
  'map/integration',
  'scenario/integration191',
  'unitset/basic',
  'scenario/five-stats',
  'portraits/191-map',
];
const rows = creationRefs.map((ref, index) => {
  const content = json(`resources/${paths[index]}.json`);
  return { ...ref, content, contentHash: hashState(content) };
});
const presets = ['regular', 'speed', 'beginner', 'hardcore'].map((key) => ({
  key,
  value: json(`resources/preset/${key}.json`),
}));
const san10Rows = (
  [
    { kind: 'MAP', name: 'san10', path: 'map/san10' },
    { kind: 'SCENARIO', name: 'san10-191', path: 'scenario/san10-191' },
    { kind: 'SCENARIO', name: 'san10-empty', path: 'scenario/san10-empty' },
    { kind: 'UNIT_SET', name: 'expanded', path: 'unitset/expanded' },
  ] as const
).map(({ kind, name, path }) => {
  const content = json(`resources/${path}.json`);
  return { kind, name, version: 1, content, contentHash: hashState(content) };
});
const allRows = [...rows, ...san10Rows],
  allPresets = [...presets, { key: 'empty', value: json('resources/preset/empty.json') }];
const expandedScenario = json('resources/scenario/san10-191-v2.json');
const expandedRows = [
  ...allRows,
  {
    kind: 'SCENARIO' as const,
    name: 'san10-191',
    version: 2,
    content: expandedScenario,
    contentHash: hashState(expandedScenario),
  },
];
// 도시 기능의 실제 구현을 대신하지 않는다. 순수 목록 검증의 등록된 분기만 확인한다.
const registered: RuleRegistry = {
  ...ruleRegistry,
  features: [
    ...ruleRegistry.features.filter((feature) => feature.key !== 'city-resources-v1'),
    { key: 'city-resources-v1', requires: [], conflicts: [] },
  ],
};
describe('AC-M3-04 원생성 설정 조회', () => {
  it('AC-P2-08·09 국가 변천 선택은 기존 확장과 별도로20기능을 고정하며 기능 누락은 거부한다', () => {
    const data = featureProfileSchema.parse(json('resources/feature-profile/expanded-191-v5.json'));
    const lifecycle = expandedCreationProfile(expandedRows, allPresets, data, ruleRegistry, 'san10-191-lifecycle');
    expect(lifecycle).toMatchObject({
      id: 'san10-191-lifecycle',
      available: true,
      featureProfileKey: 'expanded-191-v5',
      featureProfileHash: hashState(data),
    });
    if (!lifecycle.available) throw Error('국가 변천 선택이 필요합니다.');
    expect(lifecycle.ruleFeatures).toHaveLength(20);
    expect(lifecycle.ruleFeatures).toContain('nation-lifecycle-v1');
    expect(
      expandedCreationProfile(
        expandedRows,
        allPresets,
        {
          ...data,
          ruleFeatures: data.ruleFeatures.filter((key) => key !== 'nation-lifecycle-v1'),
        },
        ruleRegistry,
        'san10-191-lifecycle',
      ),
    ).toMatchObject({ available: false, code: 'FEATURE_PROFILE_UNAVAILABLE' });
    expect(expandedCreationProfile(allRows, allPresets, data, ruleRegistry, 'san10-191-lifecycle')).toMatchObject({
      available: false,
      code: 'RESOURCES_UNAVAILABLE',
    });
    expect(expandedCreationProfile(expandedRows, allPresets, data, ruleRegistry, 'san10-191-expanded')).toMatchObject({
      available: false,
      code: 'FEATURE_PROFILE_UNAVAILABLE',
    });
  });
  it('AC-P2-04·AC-P2-03 새 SAN10 확장 선택은 시나리오 2판·다섯 자원·19기능을 고정한다', () => {
    const data = json('resources/feature-profile/expanded-191-v4.json');
    const expanded = expandedCreationProfile(expandedRows, allPresets, data, ruleRegistry, 'san10-191-expanded');
    expect(expanded).toMatchObject({
      id: 'san10-191-expanded',
      available: true,
      featureProfileKey: 'expanded-191-v4',
      featureProfileHash: hashState(data),
      selection: {
        mapKey: 'san10',
        scenarioKey: 'san10-191@2',
        unitSetKey: 'expanded',
        statRulesKey: 'five-stats',
        portraitMapKey: '191-map',
      },
      suggestedEndYear: 231,
    });
    if (!expanded.available) throw Error('실제 SAN10 확장 선택이 필요합니다.');
    expect(expanded.ruleFeatures).toHaveLength(19);
    expect(expanded.resources.find((row) => row.kind === 'SCENARIO')).toMatchObject({ key: 'san10-191', version: 2 });
    expect(expandedCreationProfile(allRows, allPresets, data, ruleRegistry, 'san10-191-expanded')).toMatchObject({
      available: false,
      code: 'RESOURCES_UNAVAILABLE',
    });
    expect(expandedCreationProfile(expandedRows, allPresets, data, ruleRegistry)).toMatchObject({
      available: false,
      code: 'FEATURE_PROFILE_UNAVAILABLE',
    });
    for (const id of ['integration-v01', 'san10-191', 'san10-empty'] as const)
      expect(creationProfile(expandedRows, allPresets, ruleRegistry, id)).toEqual(
        creationProfile(allRows, allPresets, ruleRegistry, id),
      );
  });
  it('기존 프로필 바이트·규칙을 보존하고 새 형식은 장비 설정과 기능을 함께 요구한다', () => {
    const legacy = json('resources/feature-profile/expanded-191-v1.json');
    expect(hashState(legacy)).toBe('9afb4ff72357feace11d1340f425b336a6558603f0d84de8aa81e35ef1472e1f');
    expect(featureProfileSchema.parse(legacy).featureData['lineage-v1'].version).toBe(1);
    const current = featureProfileSchema.parse(json('resources/feature-profile/expanded-191-v2.json'));
    if (current.version !== 2) throw Error('새 확장 설정 형식이 아닙니다.');
    expect(current.featureData['lineage-v1'].version).toBe(2);
    expect(current.featureData['equipment-v1'].items).toHaveLength(18);
    const { 'equipment-v1': gear, ...withoutGear } = current.featureData;
    expect(gear.items).toHaveLength(18);
    expect(featureProfileSchema.safeParse({ ...current, featureData: withoutGear }).success).toBe(false);
    expect(
      featureProfileSchema.safeParse({
        ...current,
        ruleFeatures: current.ruleFeatures.filter((key) => key !== 'equipment-v1'),
      }).success,
    ).toBe(false);
  });
  it('확장 항목은 새 키·설정 해시·15기능을 요약하고 기존 항목을 보존한다', () => {
    const previous = featureProfileSchema.parse(json('resources/feature-profile/expanded-191-v2.json'));
    const data = json('resources/feature-profile/expanded-191-v3.json');
    expect(data).toEqual({
      ...previous,
      key: 'expanded-191-v3',
      ruleFeatures: ['battle-affinity-v2', ...previous.ruleFeatures],
    });
    const before = hashState(creationProfile(rows, presets));
    const expanded = expandedCreationProfile(rows, presets, data);
    expect(expanded).toMatchObject({
      id: 'integration-v01-expanded',
      available: true,
      featureProfileKey: 'expanded-191-v3',
      featureProfileHash: hashState(data),
      suggestedEndYear: 231,
    });
    if (!expanded.available) throw new Error('확장 항목을 확인하세요.');
    expect(expanded.ruleFeatures).toHaveLength(15);
    expect(expanded.ruleFeatures).toContain('battle-affinity-v2');
    expect(expandedCreationProfile(rows, presets, previous)).toMatchObject({
      available: false,
      code: 'FEATURE_PROFILE_UNAVAILABLE',
    });
    expect(expandedCreationProfile(rows, presets, { ...previous, key: 'expanded-191-v3' })).toMatchObject({
      available: false,
      code: 'FEATURE_PROFILE_UNAVAILABLE',
    });
    expect(hashState(creationProfile(rows, presets))).toBe(before);
    expect(Object.hasOwn(creationProfile(rows, presets), 'featureProfileKey')).toBe(false);
    expect(expandedCreationProfile(rows, presets, null)).toMatchObject({
      id: 'integration-v01-expanded',
      available: false,
      code: 'FEATURE_PROFILE_UNAVAILABLE',
    });
  });
  it('확장 목록 요청은 선택 boolean만 받고 생략 시 새 속성을 만들지 않는다', () => {
    const expectedUserId = '00000000-0000-4000-8000-000000000001';
    expect(creationOptionsInput.parse({ expectedUserId })).toEqual({ expectedUserId });
    for (const value of [true, false])
      expect(creationOptionsInput.parse({ expectedUserId, expandedProfiles: value }).expandedProfiles).toBe(value);
    for (const value of ['true', 1, null, {}])
      expect(creationOptionsInput.safeParse({ expectedUserId, expandedProfiles: value }).success).toBe(false);
  });
  it('도시 자원·전투 상성을 포함한 10기능을 쓰고 미등록이면 옛 프로필로 돌아가지 않는다', () => {
    expect(creationFeatures).toHaveLength(10);
    expect(creationFeatures).toContain('battle-affinity-v2');
    expect(creationFeatures).toContain('city-resources-v1');
    expect(creationFeatures).not.toContain('treaty-trade');
    const absent = {
      ...registered,
      features: registered.features.filter((feature) => feature.key !== 'city-resources-v1'),
    };
    expect(creationProfile(rows, presets, absent)).toMatchObject({ available: false, code: 'RULES_UNAVAILABLE' });
  });
  it('현재 게시내용과 프리셋에서 요약하며 원문·출처·초상 ID를 반환하지 않는다', () => {
    const profile = creationProfile(rows, presets, registered);
    expect(profile).toMatchObject({
      available: true,
      selection: creationSelection,
      startYear: 191,
      counts: { nations: 21, generals: 491, cities: 53, gates: 8, ports: 6, fields: 13, anchors: 61 },
    });
    if (!profile.available) throw new Error('지원 분기를 확인하세요.');
    expect(profile.presets.map((preset) => [preset.key, preset.turnTermMinutes])).toEqual([
      ['regular', 60],
      ['speed', 10],
      ['beginner', 30],
      ['hardcore', 60],
    ]);
    expect(profile.resources).toHaveLength(5);
    expect(JSON.stringify(profile)).not.toContain('portraits":');
    expect(
      profile.resources.every((resource) => !Object.hasOwn(resource, 'content') && !Object.hasOwn(resource, 'source')),
    ).toBe(true);
  });
  it('누락·중복·내용 해시·다른 버전이 있으면 고정 사유로 막는다', () => {
    for (const invalid of [
      rows.slice(1),
      [...rows, rows[0]!],
      rows.map((row, index) => (index === 0 ? { ...row, contentHash: 'bad' } : row)),
      rows.map((row, index) => (index === 0 ? { ...row, version: 2 } : row)),
    ]) {
      expect(creationProfile(invalid, presets, registered)).toMatchObject({
        available: false,
        code: 'RESOURCES_UNAVAILABLE',
      });
    }
  });
  it('같은 해시 표기만 믿지 않고 실제 JSON과 통합판의 개수·프로필을 검사한다', () => {
    const altered = structuredClone(rows);
    const scenario = altered[1]!.content as { startYear: number };
    scenario.startYear = 192;
    altered[1]!.contentHash = hashState(scenario);
    expect(creationProfile(altered, presets, registered)).toMatchObject({
      available: false,
      code: 'RESOURCES_UNAVAILABLE',
    });
  });
  it('프리셋 누락·손상·확장 명령은 안전한 고정 사유이며 입력은 변경하지 않는다', () => {
    const before = JSON.stringify([rows, presets]);
    for (const invalid of [
      presets.slice(1),
      presets.map((preset, index) => (index ? preset : { ...preset, value: null })),
    ])
      expect(creationProfile(rows, invalid, registered)).toMatchObject({
        available: false,
        code: 'PRESETS_UNAVAILABLE',
      });
    creationProfile(rows, presets, registered);
    expect(JSON.stringify([rows, presets])).toBe(before);
  });
  it('확인하는 프리셋의 의미가 달라지면 요약 stamp도 달라진다', () => {
    const changed = structuredClone(presets);
    (changed[0]!.value as { turnTermMinutes: number }).turnTermMinutes = 7;
    expect(hashState(creationProfile(rows, changed, registered))).not.toBe(
      hashState(creationProfile(rows, presets, registered)),
    );
  });
});

describe('AC-INT-04 SAN10 명시 생성 프로필', () => {
  it.each(['san10-191', 'san10-empty'] as const)(
    '%s는 155전략·155표식·191도로·확장병종과491명·10기능을 엄격히 고정한다',
    (id) => {
      const before = JSON.stringify([allRows, allPresets]),
        profile = creationProfile(allRows, allPresets, registered, id);
      expect(profile).toMatchObject({
        id,
        available: true,
        selection: {
          scenarioKey: id,
          mapKey: 'san10',
          unitSetKey: 'expanded',
          statRulesKey: 'five-stats',
          portraitMapKey: '191-map',
        },
        startYear: id === 'san10-empty' ? 180 : 191,
        counts: {
          nations: id === 'san10-empty' ? 0 : 21,
          generals: 491,
          cities: 147,
          gates: 8,
          ports: 0,
          fields: 0,
          anchors: 155,
          markers: 155,
          roads: 191,
        },
        ruleFeatures: creationFeatures,
      });
      if (!profile.available) throw new Error('SAN10 프로필을 확인하세요.');
      expect(profile.presets.map((preset) => preset.key)).toEqual(
        id === 'san10-empty' ? ['empty'] : ['regular', 'speed', 'beginner', 'hardcore'],
      );
      expect(profile.resources).toHaveLength(5);
      expect(profile.resources.find((resource) => resource.kind === 'SCENARIO')?.key).toBe(id);
      expect(profile.resources.find((resource) => resource.kind === 'UNIT_SET')?.key).toBe('expanded');
      expect(JSON.stringify([allRows, allPresets])).toBe(before);
    },
  );

  it('확장 병종이 미게시이면 SAN10만 닫고 통합판 basic 선택은 보존한다', () => {
    const missing = allRows.filter((row) => row.kind !== 'UNIT_SET' || row.name !== 'expanded');
    for (const id of ['san10-191', 'san10-empty'] as const)
      expect(creationProfile(missing, allPresets, registered, id)).toMatchObject({
        available: false,
        code: 'RESOURCES_UNAVAILABLE',
      });
    expect(creationProfile(missing, allPresets, registered)).toMatchObject({
      available: true,
      selection: { unitSetKey: 'basic' },
    });
  });

  it('SAN10 게시 자원이 없어도 구판을 새 지도라고 바꾸지 않고 각 프로필을 구분한다', () => {
    expect(creationProfile(rows, allPresets, registered)).toMatchObject({
      id: 'integration-v01',
      available: true,
      selection: creationSelection,
    });
    for (const id of ['san10-191', 'san10-empty'] as const)
      expect(creationProfile(rows, allPresets, registered, id)).toMatchObject({
        id,
        available: false,
        code: 'RESOURCES_UNAVAILABLE',
      });
  });

  it.each(['disabled', 'direction', 'count', 'canvas'] as const)(
    'SAN10의 %s 도로·화면 계약은 재해시해도 완화하지 않는다',
    (change) => {
      const altered = structuredClone(allRows),
        row = altered.find((row) => row.kind === 'MAP' && row.name === 'san10')!;
      const map = row.content as { routes: { enabled: boolean; direction: string }[]; canvas: { width: number } };
      if (change === 'disabled') map.routes[0]!.enabled = false;
      if (change === 'direction') map.routes[0]!.direction = 'FORWARD';
      if (change === 'count') map.routes.pop();
      if (change === 'canvas') map.canvas.width = 1401;
      row.contentHash = hashState(map);
      expect(creationProfile(altered, allPresets, registered, 'san10-191')).toMatchObject({
        available: false,
        code: 'RESOURCES_UNAVAILABLE',
      });
    },
  );

  it.each(['year', 'stats', 'nation', 'diplomacy', 'office'] as const)(
    '공백지 %s 계약은 재해시해도 역사판으로 대신하지 않는다',
    (change) => {
      const altered = structuredClone(allRows),
        row = altered.find((row) => row.kind === 'SCENARIO' && row.name === 'san10-empty')!;
      const scenario = row.content as {
        startYear: number;
        generalStats: { generalId: number }[];
        general: unknown[][];
        diplomacy: number[][];
      };
      if (change === 'year') scenario.startYear = 191;
      if (change === 'stats') scenario.generalStats[0]!.generalId = 2;
      if (change === 'nation') scenario.general[0]![3] = 1;
      if (change === 'diplomacy') scenario.diplomacy.push([1, 2, 0, 0]);
      if (change === 'office') scenario.general[0]![8] = 5;
      row.contentHash = hashState(scenario);
      expect(creationProfile(altered, allPresets, registered, 'san10-empty')).toMatchObject({
        id: 'san10-empty',
        available: false,
        code: 'RESOURCES_UNAVAILABLE',
      });
    },
  );

  it('공백지 프리셋 누락은 역사·구판 프리셋을 손상시키지 않는다', () => {
    expect(creationProfile(allRows, presets, registered, 'san10-empty')).toMatchObject({
      available: false,
      code: 'PRESETS_UNAVAILABLE',
    });
    expect(creationProfile(allRows, presets, registered, 'san10-191')).toMatchObject({ available: true });
    expect(creationProfile(allRows, presets, registered)).toMatchObject({ available: true });
  });
});
