import { describe, expect, it } from 'vitest';
import { validateUnitSet } from './unitSet';
import { codes, unitFixture } from './testFixtures';

describe('T4-76 병종 검증', () => {
  it('성벽의 계통 0과 빈 계수 배열을 허용한다', () => {
    const unit = unitFixture();
    unit.crewTypes[0]!.attackCoef = [];
    unit.crewTypes[0]!.defenceCoef = [];
    expect(validateUnitSet(unit)).toMatchObject({ status: 'pass', issues: [] });
  });
  it('중복 ID·기본 병종 누락·성벽 누락을 거부한다', () => {
    const unit = unitFixture();
    unit.crewTypes = [unit.crewTypes[1]!, structuredClone(unit.crewTypes[1]!)];
    unit.defaultCrewTypeId = 999;
    expect(codes(validateUnitSet(unit))).toEqual([
      'unitset-default-missing',
      'unitset-wall-missing',
      'unitset-crew-id-duplicate',
    ]);
  });
  it('모병 불가·없는 계통과 계수는 조언 경고이며 record 순서에 의존하지 않는다', () => {
    const unit = unitFixture();
    unit.defaultCrewTypeId = 1000;
    unit.crewTypes[1]!.armType = 9;
    unit.crewTypes[1]!.attackCoef = { z: 1, a: 1 };
    const first = validateUnitSet(unit);
    expect(first.status).toBe('pass');
    expect(codes(first)).toEqual([
      'unitset-default-not-recruitable',
      'unitset-arm-unknown',
      'unitset-coef-arm-unknown',
      'unitset-coef-arm-unknown',
    ]);
    unit.crewTypes[1]!.attackCoef = { a: 1, z: 1 };
    expect(validateUnitSet(unit)).toEqual(first);
    expect(first.issues.slice(-2).map((item) => item.params.key)).toEqual(['a', 'z']);
  });
  it('앞 병종의 경고와 뒤 병종의 오류를 목록 번호 순으로 낸다', () => {
    const unit = unitFixture();
    unit.crewTypes[0]!.armType = 9;
    unit.crewTypes.splice(1, 0, { ...unit.crewTypes[1]!, id: 1000 });
    expect(codes(validateUnitSet(unit))).toEqual(['unitset-arm-unknown', 'unitset-crew-id-duplicate']);
  });
});
