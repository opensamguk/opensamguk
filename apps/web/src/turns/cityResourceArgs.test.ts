import { expect, it } from 'vitest';
import { TEST_UNIT_SET } from '../battleSim/testUnitSet';
import { worldUnits } from '../battleSim/unitChoices';
import { argFields as argFieldsOf, buildArgs, requiredKeys } from './args';
import { cityPreparationNote, cityPreparationSchema, hasCityBranch } from './cityResourceArgs';

const city = {
  type: 'object',
  properties: {
    target: { type: 'string', const: 'city' },
    crewType: { type: 'integer', minimum: 1, maximum: 1000000 },
  },
  required: ['target', 'crewType'],
  additionalProperties: false,
};
const argFields = (schema: unknown) => argFieldsOf(schema, worldUnits(TEST_UNIT_SET).all);
const unit = { type: 'object', properties: { unitId: { type: 'integer', minimum: 1, maximum: 2147483647 } } };
const schema = { anyOf: [city, unit] };
it('INT-18C AC-INT-18C 도시/부곡 대상은 실제 union 갈래의 인자와 한계를 구분한다', () => {
  const selected = cityPreparationSchema(schema, 'city');
  const fields = argFields(selected);
  expect(fields.map((field) => field.key)).toEqual(['crewType']);
  expect(buildArgs(fields, requiredKeys(selected), { crewType: '1100', unitId: '9', target: 'unit' })).toEqual({
    args: { crewType: 1100 },
    missing: [],
  });
  expect(buildArgs(fields, requiredKeys(selected), { crewType: '0' }).missing).toEqual(['병종']);
  expect(cityPreparationSchema(schema, 'unit')).toBe(unit);
  expect(buildArgs(argFields(unit), requiredKeys(unit), { unitId: '7', crewType: '1100' }).args).toEqual({ unitId: 7 });
});
it('INT-18C AC-INT-18C 도시 갈래가 없는 스키마와 잘못된 union은 입력을 막는다', () => {
  expect(cityPreparationSchema(unit, 'city')).toBeNull();
  expect(cityPreparationSchema(unit, 'unit')).toBe(unit);
  // 갈래 판단은 명령 키가 아니라 서버 schema로 한다.
  expect(hasCityBranch(schema)).toBe(true);
  expect(hasCityBranch(unit)).toBe(false);
  expect(hasCityBranch({ anyOf: [unit, unit] })).toBe(false);
  expect(cityPreparationSchema({ anyOf: [unit, unit] }, 'unit')).toBeNull();
  expect(cityPreparationNote('recruit', 'city')).toContain('도시 수비병');
  expect(cityPreparationNote('morale', 'unit')).toContain('개인 금');
});
