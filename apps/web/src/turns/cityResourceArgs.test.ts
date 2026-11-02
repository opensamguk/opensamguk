import { expect, it } from 'vitest';
import { argFields, buildArgs, requiredKeys } from './args';
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
const unit = { type: 'object', properties: { unitId: { type: 'integer', minimum: 1, maximum: 2147483647 } } };
const schema = { anyOf: [city, unit] };
it('INT-18C AC-INT-18C 도시/부곡 대상은 실제 union 갈래의 인자와 한계를 구분한다', () => {
  const selected = cityPreparationSchema(schema, true, 'city');
  const fields = argFields(selected);
  expect(fields.map((field) => field.key)).toEqual(['crewType']);
  expect(buildArgs(fields, requiredKeys(selected), { crewType: '1100', unitId: '9', target: 'unit' })).toEqual({
    args: { crewType: 1100 },
    missing: [],
  });
  expect(buildArgs(fields, requiredKeys(selected), { crewType: '0' }).missing).toEqual(['병종']);
  expect(cityPreparationSchema(schema, true, 'unit')).toBe(unit);
  expect(buildArgs(argFields(unit), requiredKeys(unit), { unitId: '7', crewType: '1100' }).args).toEqual({ unitId: 7 });
});
it('INT-18C AC-INT-18C 구판 스키마와 문구는 보존하고 잘못된 새판 union은 입력을 막는다', () => {
  expect(cityPreparationSchema(unit, false, 'city')).toBe(unit);
  expect(cityPreparationNote(false, 'recruit', 'city')).toBeNull();
  expect(cityPreparationSchema(unit, true, 'city')).toBeNull();
  // 갈래 판단은 명령 키가 아니라 서버 schema로 한다.
  expect(hasCityBranch(schema)).toBe(true);
  expect(hasCityBranch(unit)).toBe(false);
  expect(hasCityBranch({ anyOf: [unit, unit] })).toBe(false);
  expect(cityPreparationSchema({ anyOf: [unit, unit] }, true, 'unit')).toBeNull();
  expect(cityPreparationNote(true, 'recruit', 'city')).toContain('도시 수비병');
  expect(cityPreparationNote(true, 'morale', 'unit')).toContain('개인 금');
});
