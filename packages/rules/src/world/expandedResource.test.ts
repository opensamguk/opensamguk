import { describe, expect, it } from 'vitest';
import { testUnits } from '../../test/commandFixture';
import { operationalInput } from '../../test/operationalMapFixture';
import { buildInitialWorld } from './bootstrap';
import { unitSetSchema } from './resources';
import { validateUnitSet as validateEditorUnits } from './resourceEditor/validate/unitSet';
import { validateUnitSet as validateUnits } from './validate/unitSet';

describe('INT-22 확장 병종·지도 자원 경계', () => {
  it('병종 ID·계열·성벽0 계수와 0배수를 두 검증기에서 허용한다', () => {
    const unitSet = structuredClone(testUnits);
    unitSet.crewTypes[1]!.attackCoef = { '0': 0, '2': 1.2, '1200': 0.9 };
    expect(validateUnits(unitSet)).toMatchObject({ status: 'pass', issues: [] });
    expect(validateEditorUnits(unitSet)).toMatchObject({ ok: true, issues: [] });
    unitSet.armTypes['01'] = '잘못된 계열';
    expect(validateUnits(unitSet).issues).toContainEqual(expect.objectContaining({ code: 'unitset-arm-key-invalid' }));
    expect(validateEditorUnits(unitSet).issues).toContainEqual(
      expect.objectContaining({ code: 'unitset-arm-key-invalid' }),
    );
  });
  it('알 수 없는 계수와 병종 ID/계열의 충돌은 두 검증기에서 오류다', () => {
    const unitSet = structuredClone(testUnits);
    unitSet.crewTypes[1]!.attackCoef = { '9999': 1 };
    expect(validateUnits(unitSet).issues).toContainEqual(
      expect.objectContaining({ code: 'unitset-coef-arm-unknown', severity: 'error' }),
    );
    expect(validateEditorUnits(unitSet).ok).toBe(false);
    unitSet.crewTypes[1]!.attackCoef = {};
    unitSet.armTypes['1100'] = '겹침';
    expect(validateUnits(unitSet).issues).toContainEqual(
      expect.objectContaining({ code: 'unitset-id-arm-collision', severity: 'error' }),
    );
    expect(validateEditorUnits(unitSet).issues).toContainEqual(
      expect.objectContaining({ code: 'unitset-id-arm-collision', severity: 'error' }),
    );
  });
  it.each([
    { requirements: [{ kind: 'regions', regions: [17] }] },
    { requirements: [{ kind: 'regions', regions: [] }] },
    { requirements: [{ kind: 'research', name: 'ghost' }] },
    { requirements: [{ kind: 'tech', min: -1 }] },
    { requirements: [{ kind: 'chief', extra: true }] },
    { requirements: [{ kind: 'unknown' }] },
    { effects: ['unknown'] },
  ])('잘못된 조건·효과를 버리지 않고 거부한다 %o', (fields) => {
    const unitSet = structuredClone(testUnits);
    Object.assign(unitSet.crewTypes[1]!, fields);
    expect(unitSetSchema.safeParse(unitSet).success).toBe(false);
  });
  it('지역 기준이 없는 옛 운영 지도는 확장 병종과 만들 수 없고 같은 기준이면 region16까지 보존한다', () => {
    const input = operationalInput();
    const unitSet = { ...input.unitSet, coefMode: 'multiply', regionScheme: 'province-191' };
    expect(() => buildInitialWorld({ ...input, unitSet })).toThrow('지역 기준');
    input.map.regionScheme = 'province-191';
    const city = input.map.sites.find((row) => row.kind === 'CITY')!;
    if (city.kind !== 'CITY') throw new Error('도시 고정물이 필요합니다.');
    city.region = 16;
    const initial = buildInitialWorld({ ...input, unitSet });
    expect(initial.cities.find((row) => row.cityKey === city.anchorKey)?.region).toBe(16);
    expect(initial.operationalMap?.regionScheme).toBe('province-191');
    expect(initial.unitSet).toMatchObject({ coefMode: 'multiply', regionScheme: 'province-191' });
    city.region = 17;
    expect(() => buildInitialWorld({ ...input, unitSet })).toThrow();
  });
});
