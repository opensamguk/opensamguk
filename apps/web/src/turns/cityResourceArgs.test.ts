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

// 서버 commands.list의 모병 인자(z.union([cityRecruitArgs, campaignRecruitArgs])의 z.toJSONSchema 결과).
const recruitSchema = {
  anyOf: [
    {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, maximum: 1000000 },
        crewType: { type: 'integer', minimum: 1, maximum: 1000000 },
      },
      required: ['amount', 'crewType'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        amount: { type: 'integer', minimum: 1, maximum: 1000000 },
        crewType: { type: 'integer', minimum: 1, maximum: 1000000 },
        unitId: {
          anyOf: [
            { type: 'integer', minimum: 1, maximum: 2147483647 },
            { type: 'string', const: 'new' },
          ],
        },
      },
      required: ['amount', 'crewType'],
      additionalProperties: false,
    },
  ],
};
it('모병의 도시 수비병 갈래는 unitId 없는 갈래이고, 부곡 갈래는 새 부곡이나 내 부곡을 고른다', () => {
  expect(hasCityBranch(recruitSchema)).toBe(true);
  const garrison = cityPreparationSchema(recruitSchema, 'city');
  expect(argFields(garrison).map((field) => field.key)).toEqual(['amount', 'crewType']);
  const branch = cityPreparationSchema(recruitSchema, 'unit');
  expect(branch).toBe(recruitSchema.anyOf[1]);
  // 내 부곡을 받기 전에도 새 부곡은 고를 수 있다.
  const before = argFieldsOf(branch, worldUnits(TEST_UNIT_SET).all);
  expect(before.find((field) => field.key === 'unitId')).toMatchObject({
    kind: 'campaignUnit',
    options: [{ value: 'new', label: '새 부곡' }],
  });
  const fields = argFieldsOf(branch, worldUnits(TEST_UNIT_SET).all, [{ id: 3, troops: 1200, crewType: 1100 }]);
  const unitField = fields.find((field) => field.key === 'unitId');
  expect(unitField).toMatchObject({ kind: 'campaignUnit', label: '부곡' });
  expect(unitField?.kind === 'campaignUnit' ? unitField.options.map((option) => option.value) : []).toEqual([
    'new',
    '3',
  ]);
  const required = requiredKeys(branch);
  expect(buildArgs(fields, required, { amount: '100', crewType: '1100', unitId: 'new' }).args).toEqual({
    amount: 100,
    crewType: 1100,
    unitId: 'new',
  });
  expect(buildArgs(fields, required, { amount: '100', crewType: '1100', unitId: '3' }).args).toEqual({
    amount: 100,
    crewType: 1100,
    unitId: 3,
  });
  // 목록에 없는 부곡 번호는 넣지 않는다.
  expect(buildArgs(fields, required, { amount: '100', crewType: '1100', unitId: '9' }).missing).toEqual(['부곡']);
  expect(cityPreparationNote('recruit', 'unit')).toContain('부곡');
  expect(cityPreparationNote('recruit', 'city')).toContain('도시 수비병');
});

it('국가 배속의 부곡 칸은 같은 국가의 다른 장수 부곡도 소유자와 행군 중인지와 함께 고른다', () => {
  const allocate = {
    type: 'object',
    properties: {
      cityKey: { type: 'integer', minimum: 1 },
      crewType: { type: 'integer', minimum: 1 },
      amount: { type: 'integer', minimum: 1 },
      unitId: {
        anyOf: [
          { type: 'integer', minimum: 1, maximum: 2147483647 },
          { type: 'string', const: 'new' },
        ],
      },
      recipientId: { type: 'integer', minimum: 1 },
    },
    required: ['cityKey', 'crewType', 'amount', 'unitId'],
  };
  const fields = argFieldsOf(allocate, worldUnits(TEST_UNIT_SET).all, [
    { id: 3, troops: 1200, crewType: 1100, ownerName: '관우' },
    { id: 4, troops: 800, crewType: 1100, ownerName: '장비', marching: true },
  ]);
  const unitField = fields.find((field) => field.key === 'unitId');
  expect(unitField?.kind === 'campaignUnit' ? unitField.options : []).toEqual([
    { value: 'new', label: '새 부곡' },
    { value: '3', label: '부곡 3 · 시험 보병 1,200명 (관우)' },
    { value: '4', label: '부곡 4 · 시험 보병 800명 (장비), 행군 중' },
  ]);
});
