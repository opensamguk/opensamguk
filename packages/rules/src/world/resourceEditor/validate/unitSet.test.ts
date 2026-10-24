import { describe, expect, it } from 'vitest';
import type { UnitSetResource } from '../resources';
import { unitSetFixture } from './fixtures';
import { validateUnitSet } from './unitSet';
import type { IssueTarget, ResourceIssueCode } from './issues';

const cases: Array<[ResourceIssueCode, (s: UnitSetResource) => void, IssueTarget]> = [
  [
    'resource-id-mismatch',
    (s) => {
      s.id = 'other';
    },
    { kind: 'root' },
  ],
  [
    'unitset-arm-key-invalid',
    (s) => {
      s.armTypes['01'] = '계열';
    },
    { kind: 'armType', key: '01' },
  ],
  [
    'unitset-crew-id-duplicate',
    (s) => {
      s.crewTypes[2]!.id = 1;
    },
    { kind: 'crewType', index: 2 },
  ],
  [
    'unitset-crew-name-duplicate',
    (s) => {
      s.crewTypes[2]!.name = s.crewTypes[1]!.name;
    },
    { kind: 'crewType', index: 2 },
  ],
  [
    'unitset-crew-arm-missing',
    (s) => {
      s.crewTypes[1]!.armType = 9;
    },
    { kind: 'crewType', index: 1 },
  ],
  [
    'unitset-coef-arm-missing',
    (s) => {
      s.crewTypes[1]!.attackCoef = { '9': 1 };
    },
    { kind: 'crewType', index: 1 },
  ],
  [
    'unitset-default-missing',
    (s) => {
      s.defaultCrewTypeId = 9;
    },
    { kind: 'root' },
  ],
  [
    'unitset-default-not-recruitable',
    (s) => {
      s.defaultCrewTypeId = 1000;
    },
    { kind: 'root' },
  ],
  [
    'unitset-wall-missing',
    (s) => {
      s.crewTypes.shift();
    },
    { kind: 'root' },
  ],
];
describe('병종 검증', () => {
  it.each(cases)('%s 실패와 고친 통과', (code, change, target) => {
    const value = unitSetFixture();
    expect(validateUnitSet(value, { expectedId: 'units' }).issues).toEqual([]);
    change(value);
    const result = validateUnitSet(value, { expectedId: 'units' });
    expect(result.issues.map((i) => i.code)).toEqual([code]);
    expect(result.issues[0]).toMatchObject({ target, severity: 'error' });
    expect(result.ok).toBe(false);
  });
  it('수치 형식 오류는 뜻 검사 전에 멈추고 계수는 양쪽을 검사한다', () => {
    const value = unitSetFixture();
    value.crewTypes[1]!.avoid = 101;
    const result = validateUnitSet(value, { expectedId: 'other' });
    expect(result.value).toBeNull();
    expect(result.issues.map((i) => i.code)).toEqual(['shape-invalid']);
    value.crewTypes[1]!.avoid = 100;
    value.crewTypes[1]!.defenceCoef = { '9': 1 };
    expect(validateUnitSet(value).issues[0]?.code).toBe('unitset-coef-arm-missing');
  });
  it('성벽은 ID만 보고 모병 불가 0은 별도 계열이 필요하지 않다', () => {
    const value = unitSetFixture();
    value.crewTypes[0]!.armType = 1;
    expect(validateUnitSet(value).issues).toEqual([]);
    value.crewTypes[0]!.armType = 0;
    expect(validateUnitSet(value).issues).toEqual([]);
  });
});
