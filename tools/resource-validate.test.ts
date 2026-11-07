import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildInitialWorld } from '../packages/rules/src/world/bootstrap';
import { validateWorldResources } from '../packages/rules/src/world/validate/index';
import { mapFixture, scenarioFixture, unitFixture } from '../packages/rules/src/world/validate/testFixtures';

describe('T4-76 실제 내장 자원과 기존 생성 함수', () => {
  it('Node가 공개 subpath를 이 feature의 파일로 해석한다', () => {
    const require = createRequire(new URL('../packages/rules/package.json', import.meta.url));
    const resolved = require.resolve('@opensamguk/rules/resource-validation');
    expect(resolved.replaceAll('\\', '/')).toBe(
      fileURLToPath(new URL('../packages/rules/src/world/validate/index.ts', import.meta.url)).replaceAll('\\', '/'),
    );
    expect(() => require.resolve('@opensamguk/rules/resource-validation/limits')).toThrow();
  });
});

const fixture = () => ({
  map: mapFixture(),
  scenario: scenarioFixture(),
  unitSet: unitFixture(),
  statRules: { stat: { total: 165, min: 15, max: 80 } },
  seed: 'refusal',
});
type Bundle = ReturnType<typeof fixture>;
const refusals: { label: string; code: string; mutate: (bundle: Bundle) => void }[] = [
  {
    label: '도시 ID',
    code: 'city-id-duplicate',
    mutate: (b) => {
      b.map.cities[1]!.id = 1;
    },
  },
  {
    label: '도시 이름',
    code: 'city-name-duplicate',
    mutate: (b) => {
      b.map.cities[1]!.name = '도시1';
    },
  },
  {
    label: '중복 연결',
    code: 'link-duplicate',
    mutate: (b) => {
      b.map.cities[0]!.connections.push(2);
    },
  },
  {
    label: '자기 연결',
    code: 'link-self',
    mutate: (b) => {
      b.map.cities[0]!.connections.push(1);
    },
  },
  {
    label: '없는 연결',
    code: 'link-missing-city',
    mutate: (b) => {
      b.map.cities[0]!.connections.push(99);
    },
  },
  {
    label: '한쪽 연결',
    code: 'link-one-way',
    mutate: (b) => {
      b.map.cities[1]!.connections = [];
    },
  },
  {
    label: '초기 최대치',
    code: 'city-initial-over-max',
    mutate: (b) => {
      b.map.cities[0]!.initial.wall = 101;
    },
  },
  {
    label: '병종 ID',
    code: 'unitset-crew-id-duplicate',
    mutate: (b) => {
      b.unitSet.crewTypes.push(structuredClone(b.unitSet.crewTypes[1]!));
    },
  },
  {
    label: '기본 병종',
    code: 'unitset-default-missing',
    mutate: (b) => {
      b.unitSet.defaultCrewTypeId = 999;
    },
  },
  {
    label: '국가 도시',
    code: 'scenario-nation-city-missing',
    mutate: (b) => {
      b.scenario.nation[0]![8] = ['없음'];
    },
  },
  {
    label: '도시 소유',
    code: 'scenario-city-owner-duplicate',
    mutate: (b) => {
      b.scenario.nation[0]![8].push('도시1');
    },
  },
  {
    label: '장수 국가',
    code: 'scenario-general-nation-missing',
    mutate: (b) => {
      b.scenario.general[0]![3] = 99;
    },
  },
  {
    label: '생몰년',
    code: 'scenario-general-years',
    mutate: (b) => {
      b.scenario.general[0]![9] = 201;
    },
  },
  {
    label: '장수 도시',
    code: 'scenario-general-city-missing',
    mutate: (b) => {
      b.scenario.general[0]![4] = '없음';
    },
  },
  {
    label: '외교 같은 국가',
    code: 'scenario-diplomacy-invalid',
    mutate: (b) => {
      b.scenario.diplomacy.push([1, 1, 0, 1]);
    },
  },
  {
    label: '외교 없는 국가',
    code: 'scenario-diplomacy-invalid',
    mutate: (b) => {
      b.scenario.diplomacy.push([1, 99, 0, 1]);
    },
  },
];
describe('T4-76 기존 생성 거부 대조', () => {
  it.each(refusals)('$label 거부를 같은 검사 코드로 설명한다', ({ mutate, code }) => {
    const bundle = fixture();
    mutate(bundle);
    expect(() => buildInitialWorld(bundle)).toThrow();
    const report = validateWorldResources(bundle);
    expect(report.status).toBe('fail');
    expect(
      Object.values(report)
        .filter((item) => typeof item === 'object')
        .flatMap((item) => item.issues.map((entry) => entry.code)),
    ).toContain(code);
  });
});
