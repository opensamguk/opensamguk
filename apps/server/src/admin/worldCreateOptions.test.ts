import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashState } from '@opensamguk/shared/node';
import { ruleRegistry, type RuleRegistry } from '@opensamguk/rules';
import { creationFeatures, creationProfile, creationRefs, creationSelection } from './worldCreateOptions';

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
// 도시 기능의 실제 구현을 대신하지 않는다. 순수 목록 검증의 등록된 분기만 확인한다.
const registered: RuleRegistry = {
  ...ruleRegistry,
  features: [
    ...ruleRegistry.features.filter((feature) => feature.key !== 'city-resources-v1'),
    { key: 'city-resources-v1', requires: [], conflicts: [] },
  ],
};
describe('AC-M3-04 원생성 설정 조회', () => {
  it('정확한 도시 자원9기능만 쓰고 미등록이면 옛 프로필로 돌아가지 않는다', () => {
    expect(creationFeatures).toHaveLength(9);
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
