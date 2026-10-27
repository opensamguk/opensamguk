import { describe, expect, it } from 'vitest';
import { validateResource as publicValidateResource, type MapResourceV2 } from '@opensamguk/rules/resources';
import * as publicResources from '@opensamguk/rules/resources';
import { mapSchema as legacyMapSchema } from '@opensamguk/rules';
import {
  validatePortraitMap,
  validateResource,
  validateStatRules,
  resourceIssue,
  RESOURCE_ISSUES,
  type ResourceKind,
} from './index';
import { mapFixture, scenarioFixture, unitSetFixture } from './fixtures';

describe('능력치·초상·공개 검증기', () => {
  it('INT-14 / AC-INT-14 새 판의 다섯 능력치를 같은 개수로 검증한다', () => {
    const stat = { count: 5, total: 275, min: 15, max: 90 };
    expect(validateStatRules({ stat })).toMatchObject({ ok: true, value: { stat } });
    expect(validateStatRules({ stat: { ...stat, total: 451 } }).ok).toBe(false);
    expect(validateStatRules({ stat: { ...stat, total: 74 } }).ok).toBe(false);
    expect(validateStatRules({ stat: { ...stat, count: 4 } }).ok).toBe(false);
  });
  it('공개 하위 경로의 값과 타입을 해석한다', () => {
    const map: MapResourceV2 = mapFixture();
    expect(publicValidateResource).toBe(validateResource);
    expect(publicValidateResource('MAP', map).ok).toBe(true);
  });
  it('공개 지도 형식 이름과 기존 월드 생성용 이름을 구별합니다.', () => {
    const map = mapFixture();
    expect(publicResources.mapResourceSchema.parse(map)).toEqual(map);
    expect(publicResources).not.toHaveProperty('mapSchema');
    const legacy = legacyMapSchema.parse(map);
    expect(legacy).not.toHaveProperty('version');
    expect(legacy).not.toHaveProperty('terrain');
  });
  it.each([
    { total: 30, min: 20, max: 10 },
    { total: 29, min: 10, max: 20 },
    { total: 61, min: 10, max: 20 },
  ])('능력치 모순은 뜻 오류이고 읽은 값을 돌려준다: %j', (stat) => {
    expect(validateStatRules({ stat })).toMatchObject({
      ok: false,
      value: { stat },
      issues: [resourceIssue('stat-rules-inconsistent', stat)],
    });
    expect(validateStatRules({ stat: { total: 30, min: 10, max: 10 } }).issues).toEqual([]);
  });
  it('능력치 형식 오류와 수치 모순이 함께 있으면 형식만 돌려준다', () => {
    const result = validateStatRules({ stat: { total: -1, min: 100, max: 1 } });
    expect(result.value).toBeNull();
    expect(result.issues.map((i) => i.code)).toEqual(['shape-invalid']);
  });
  it('초상 범위·빈 이름은 형식 오류이고 같은 ID는 경고다', () => {
    for (const portraits of [{ 장수: 10000 }, { 장수: 11001 }, { '': 10001 }]) {
      expect(validatePortraitMap({ portraits })).toMatchObject({ ok: false, value: null });
    }
    expect(validatePortraitMap({ portraits: { 장수1: 10001, 장수2: 11000 } }).issues).toEqual([]);
    expect(validatePortraitMap({ portraits: { 장수1: 10001, 장수2: 10001 } })).toMatchObject({
      ok: true,
      issues: [{ code: 'portrait-id-duplicate', severity: 'warning', target: { kind: 'portrait', name: '장수2' } }],
    });
  });
  it('서버 짝 지도 코드는 같은 틀을 쓰고 미지정과 없는 판의 문구를 구별한다', () => {
    const missing = resourceIssue('scenario-map-missing', {});
    const unknown = resourceIssue('scenario-map-missing', { mapKey: 'missing@2' });
    expect(missing.message).toBe('시나리오의 짝 지도를 지정해야 합니다.');
    expect(unknown.message).toBe('시나리오의 짝 지도를 찾을 수 없습니다 (missing@2).');
    expect(missing.message).not.toBe(unknown.message);
    for (const issue of [missing, unknown, resourceIssue('scenario-map-unpublished', { mapKey: 'che@2' })]) {
      expect(issue).toMatchObject({ severity: 'error', target: { kind: 'root' } });
      expect(Object.values(issue.params).every((v) => typeof v === 'string' || typeof v === 'number')).toBe(true);
    }
  });
  it('다섯 종류를 고르고 알 수 없는 종류는 던진다', () => {
    const values: Array<[ResourceKind, unknown]> = [
      ['MAP', mapFixture()],
      ['SCENARIO', scenarioFixture()],
      ['UNIT_SET', unitSetFixture()],
      ['STAT_RULES', { stat: { total: 165, min: 15, max: 80 } }],
      ['PORTRAIT_MAP', { portraits: {} }],
    ];
    for (const [kind, content] of values) {
      expect(validateResource(kind, content, { map: mapFixture() }).ok).toBe(true);
    }
    expect(validateResource('MAP', mapFixture(), { expectedId: 'other' }).issues[0]?.code).toBe('resource-id-mismatch');
    expect(validateResource('SCENARIO', scenarioFixture()).issues[0]?.code).toBe('scenario-map-invalid');
    expect(() => validateResource('OTHER' as ResourceKind, {})).toThrow();
  });
  it('모든 코드의 params 키가 고정되어 문구 순서가 입력 객체 순서에 흔들리지 않는다', () => {
    for (const code of Object.keys(RESOURCE_ISSUES) as Array<keyof typeof RESOURCE_ISSUES>) {
      const keys = RESOURCE_ISSUES[code][1];
      const params = Object.fromEntries(keys.map((key, i) => [key, i]));
      expect(resourceIssue(code, params)).toEqual(
        resourceIssue(code, Object.fromEntries(Object.entries(params).reverse())),
      );
      expect(resourceIssue(code, params).message.endsWith('.')).toBe(true);
    }
  });
});
