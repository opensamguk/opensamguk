import { describe, expect, it } from 'vitest';
import {
  validateMap,
  validateScenario,
  validateUnitSet,
  validateStatRules,
  validatePortraitMap,
  RESOURCE_LIMITS,
  type MapResource,
  type ScenarioResource,
  type UnitSetResource,
  type ResourceKind,
  type ResourceReport,
} from '@opensamguk/rules/resource-validation';
import { hashState } from '@opensamguk/shared/node';
import { checkContent, makeLimits, measureJson, RESULT_FIELD_ALLOWANCE_BYTES } from './payload';
import { publishVerdict, type VerdictContext } from './verdict';

function mapFixture(): MapResource {
  const values = { population: 100, agriculture: 100, commerce: 100, security: 100, defence: 100, wall: 100 };
  return {
    id: 'map',
    name: '지도',
    defaults: { trust: 50, supplyState: 1 },
    cities: [
      {
        id: 1,
        name: '도시',
        level: 1,
        region: 1,
        position: { x: 0, y: 0 },
        connections: [],
        max: { ...values },
        initial: { ...values },
      },
    ],
  };
}

function scenarioFixture(): ScenarioResource {
  return {
    id: 'scenario',
    title: '시나리오',
    startYear: 190,
    nation: [['나라', '#123456', 0, 0, '', 0, '', 0, ['도시']]],
    general: [],
    diplomacy: [],
  };
}

function unitFixture(): UnitSetResource {
  const base = {
    name: '병종',
    attack: 1,
    defence: 1,
    speed: 1,
    avoid: 0,
    magicCoef: 1,
    cost: 1,
    rice: 1,
    attackCoef: {},
    defenceCoef: {},
  };
  return {
    id: 'units',
    name: '병종표',
    defaultCrewTypeId: 1,
    armTypes: { 1: '보병' },
    crewTypes: [
      { ...base, id: 1, armType: 1 },
      { ...base, id: 1000, armType: 0 },
    ],
  };
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function view(report: ResourceReport<unknown>) {
  const { value, ...result } = report;
  void value;
  return result;
}

describe('자원 게시 판정', () => {
  const cases: [
    ResourceKind,
    () => unknown,
    () => VerdictContext | undefined,
    (value: unknown, context: VerdictContext | undefined) => ResourceReport<unknown>,
  ][] = [
    [
      'MAP',
      mapFixture,
      () => ({ scenarios: [scenarioFixture()] }),
      (value, ctx) => validateMap(value, { scenarios: ctx!.scenarios! }),
    ],
    [
      'SCENARIO',
      scenarioFixture,
      () => ({ map: mapFixture() }),
      (value, ctx) => validateScenario(value, { map: ctx!.map }),
    ],
    ['UNIT_SET', unitFixture, () => undefined, validateUnitSet],
    ['STAT_RULES', () => ({ stat: { total: 180, min: 30, max: 100 } }), () => undefined, validateStatRules],
    ['PORTRAIT_MAP', () => ({ portraits: { 가: 10001 } }), () => undefined, validatePortraitMap],
  ];

  it.each(cases)('%s는 실제 검증기의 pass 보고에서 value만 뺀다', (kind, fixture, context, validate) => {
    const raw = frozen(fixture());
    const ctx = frozen(context());
    const before = hashState(raw);
    const expected = validate(raw, ctx);
    expect(expected.status).toBe('pass');
    const result = publishVerdict(kind, raw, ctx);
    expect(result).toEqual({ publishable: true, report: view(expected) });
    expect(Object.keys(result.report).sort()).toEqual(['issues', 'kind', 'ran', 'skipped', 'status', 'truncated']);
    expect('value' in result.report).toBe(false);
    expect(hashState(raw)).toBe(before);
  });

  it.each(cases)('%s의 형식 실패를 pass나 incomplete로 낮추지 않는다', (kind, _fixture, context, validate) => {
    const ctx = context();
    const expected = validate({}, ctx);
    expect(expected.status).toBe('fail');
    expect(publishVerdict(kind, {}, ctx)).toEqual({ publishable: false, report: view(expected) });
  });

  it('경고만 있는 실제 병종 보고는 게시 가능하다', () => {
    const raw = unitFixture();
    raw.defaultCrewTypeId = 1000;
    const result = publishVerdict('UNIT_SET', raw);
    expect(result.publishable).toBe(true);
    expect(result.report.status).toBe('pass');
    expect(result.report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unitset-default-not-recruitable', severity: 'warning' }),
      ]),
    );
  });

  it('지도와 시나리오는 맥락을 생략한 채 incomplete로 남긴다', () => {
    for (const [kind, raw, group] of [
      ['MAP', mapFixture(), 'scenario-refs'],
      ['SCENARIO', scenarioFixture(), 'map-refs'],
    ] as const) {
      const result = publishVerdict(kind, raw);
      expect(result).toMatchObject({
        publishable: false,
        report: { status: 'incomplete', skipped: [{ group, reason: 'context-missing' }] },
      });
    }
  });

  it.each(['MAP', 'SCENARIO'] as const)('%s는 자체 오류와 맥락 부재가 함께 있으면 fail을 우선한다', (kind) => {
    const map = mapFixture();
    map.cities[0]!.position.x = -1;
    const scenario = scenarioFixture();
    scenario.diplomacy = [[1, 1, 0, 0]];
    const result = publishVerdict(kind, kind === 'MAP' ? map : scenario);
    expect(result.publishable).toBe(false);
    expect(result.report.status).toBe('fail');
    expect(result.report.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(result.report.skipped).toContainEqual({
      group: kind === 'MAP' ? 'scenario-refs' : 'map-refs',
      reason: 'context-missing',
    });
  });

  it('맥락 생략과 호출자가 명시한 빈 맥락을 혼동하지 않는다', () => {
    const raw = mapFixture();
    expect(publishVerdict('MAP', raw).publishable).toBe(false);
    expect(publishVerdict('MAP', raw, { scenarios: [] }).publishable).toBe(true);
  });

  it('깨진 맥락과 맥락의 참조 오류를 검증기 그대로 남긴다', () => {
    expect(publishVerdict('MAP', mapFixture(), { scenarios: [{}] })).toMatchObject({
      publishable: false,
      report: {
        status: 'incomplete',
        skipped: [{ group: 'scenario-refs', reason: 'context-invalid', contextIndex: 0 }],
      },
    });
    expect(publishVerdict('SCENARIO', scenarioFixture(), { map: {} })).toMatchObject({
      publishable: false,
      report: { status: 'incomplete', skipped: [{ group: 'map-refs', reason: 'context-invalid' }] },
    });
    const scenario = scenarioFixture();
    scenario.nation[0]![8] = ['표식@example.invalid'];
    const expected = validateMap(mapFixture(), { scenarios: [scenario] });
    const result = publishVerdict('MAP', mapFixture(), { scenarios: [scenario] });
    expect(result).toEqual({ publishable: false, report: view(expected) });
    expect(result.report.issues).toContainEqual(
      expect.objectContaining({
        code: 'scenario-nation-city-missing',
        params: { name: '표식@example.invalid' },
        source: { kind: 'SCENARIO', index: 0 },
      }),
    );
  });

  it('32개 맥락과 초과 오류도 새 코드 없이 전달한다', () => {
    const scenarios = Array.from({ length: RESOURCE_LIMITS.contextScenarios }, scenarioFixture);
    expect(publishVerdict('MAP', mapFixture(), { scenarios }).publishable).toBe(true);
    scenarios.push(scenarioFixture());
    const expected = validateMap(mapFixture(), { scenarios });
    expect(publishVerdict('MAP', mapFixture(), { scenarios })).toEqual({ publishable: false, report: view(expected) });
    expect(expected.issues[0]?.code).toBe('resource-too-large');
  });

  it('앞 1000개가 경고여도 뒤에 감춰진 실제 오류의 fail과 truncated를 보존한다', () => {
    const raw = mapFixture();
    const city = raw.cities[0]!;
    raw.cities = Array.from({ length: RESOURCE_LIMITS.cities }, (_, index) => ({
      ...structuredClone(city),
      id: index + 1,
      name: index === 0 ? '도시' : `도시${index}`,
      level: 0,
      region: 0,
      connections: [((index + 999) % 1000) + 1, ((index + 1) % 1000) + 1],
    }));
    raw.cities.at(-1)!.id = raw.cities.at(-2)!.id;
    const context = { scenarios: [scenarioFixture()] };
    const expected = validateMap(raw, context);
    expect(expected.status).toBe('fail');
    expect(expected.truncated).toBe(true);
    expect(expected.issues).toHaveLength(RESOURCE_LIMITS.diagnostics);
    expect(expected.issues.every((item) => item.severity === 'warning')).toBe(true);
    expect(publishVerdict('MAP', frozen(raw), context)).toEqual({ publishable: false, report: view(expected) });
  });

  it('1000개 긴 진단의 바이트 경계에서 보고를 자르거나 판정을 바꾸지 않는다', () => {
    const raw = unitFixture();
    const coefficients = Object.fromEntries(
      Array.from({ length: RESOURCE_LIMITS.coefficientKeys }, (_, index) => [`긴이름😀${'키'.repeat(40)}${index}`, 1]),
    );
    raw.defaultCrewTypeId = 1000;
    raw.crewTypes[0]!.attackCoef = coefficients;
    raw.crewTypes[0]!.defenceCoef = { ...coefficients };
    const result = frozen(publishVerdict('UNIT_SET', frozen(raw)));
    expect(result).toMatchObject({ publishable: true, report: { status: 'pass', truncated: true } });
    expect(result.report.issues).toHaveLength(RESOURCE_LIMITS.diagnostics);
    const before = JSON.stringify(result);
    const size = Buffer.byteLength(before, 'utf8');
    expect(measureJson(result, size)).toEqual({ ok: true, bytes: size });
    expect(measureJson(result, size - 1)).toEqual({ ok: false });
    expect(JSON.stringify(result)).toBe(before);
    expect(result.report.status).toBe('pass');
    expect('value' in result.report).toBe(false);
  });

  it('v1 원문과 미지 필드는 그대로 보관하고 검증기의 parsed value로 바꾸지 않는다', () => {
    const raw = { ...mapFixture(), extra: { original: '원문' } };
    const cap = Buffer.byteLength(JSON.stringify(raw), 'utf8');
    const checked = checkContent(
      raw,
      makeLimits({ depthMax: 16, contentMax: cap, metaMax: 1, responseMax: cap + 1 + RESULT_FIELD_ALLOWANCE_BYTES }),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error('검사 통과가 필요합니다.');
    const report = publishVerdict('MAP', checked.content).report;
    expect(report.status).toBe('incomplete');
    expect(checked.content).toBe(raw);
    expect(checked.content.extra).toEqual({ original: '원문' });
    expect('version' in raw).toBe(false);
    expect('value' in report).toBe(false);
    expect(report).toEqual(view(validateMap(raw)));
  });

  it('런타임의 잘못된 kind는 입력값 없는 고정 오류다', () => {
    expect(() => publishVerdict('private-marker' as ResourceKind, {})).toThrow('invalid_resource_kind');
  });
});
