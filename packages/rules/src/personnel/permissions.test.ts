import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  APPOINTABLE_OFFICER_LEVELS,
  NATION_COMMAND_PERMISSIONS,
  OFFICER_ROLES,
  canExecuteNationCommand,
  canManagePersonnel,
  canUseNationTurns,
  isAppointableOfficerLevel,
  nationCommandKeys,
  officerRole,
  officerTitle,
  type AppointableOfficerLevel,
  type NationCommandKey,
  type OfficerLevel,
} from './permissions';

const levels = [0, 1, 5, 6, 7, 8, 9, 10, 11, 12];
const staff = [5, 6, 7, 8, 9, 10, 11, 12];
const commands = [
  { key: 'nation_rest', allowed: staff },
  { key: 'nation_reward', allowed: staff },
  { key: 'nation_seize', allowed: staff },
  { key: 'nation_assign', allowed: staff },
  { key: 'nation_peace', allowed: [11, 12] },
  { key: 'nation_pact', allowed: [11, 12] },
  { key: 'nation_break_pact', allowed: [11, 12] },
  { key: 'nation_aid', allowed: [11, 12] },
  { key: 'nation_declare', allowed: [12] },
  { key: 'nation_capital', allowed: [12] },
] as const;

describe('T2-05 / AC-M2-05·16 순수 직책·명령 권한표', () => {
  it.each(
    levels.flatMap((officerLevel) =>
      commands.map(({ key, allowed }) => ({
        officerLevel,
        commandKey: key,
        expected: allowed.some((level) => level === officerLevel),
      })),
    ),
  )('직책 $officerLevel × $commandKey = $expected', ({ officerLevel, commandKey, expected }) => {
    expect(canExecuteNationCommand(officerLevel, commandKey)).toBe(expected);
    expect(nationCommandKeys(officerLevel).includes(commandKey)).toBe(expected);
  });

  it.each([
    { level: 12, title: '군주', turns: true, manage: true, appointable: false },
    { level: 11, title: '참모', turns: true, manage: false, appointable: true },
    ...[5, 6, 7, 8, 9, 10].map((level) => ({ level, title: '수뇌', turns: true, manage: false, appointable: true })),
    { level: 1, title: '장수', turns: false, manage: false, appointable: false },
    { level: 0, title: '재야', turns: false, manage: false, appointable: false },
  ])('직책 $level의 이름·국가 예턴·인사·임명 가능 여부', ({ level, title, turns, manage, appointable }) => {
    expect(officerTitle(level)).toBe(title);
    expect(officerRole(level)?.title).toBe(title);
    expect(canUseNationTurns(level)).toBe(turns);
    expect(canManagePersonnel(level)).toBe(manage);
    expect(isAppointableOfficerLevel(level)).toBe(appointable);
  });

  it('명령 표와 직책 표가 한 원본으로 일치하고 임명 목록은 11·10~5뿐이다', () => {
    expect(OFFICER_ROLES.flatMap((role) => [...role.levels]).sort((a, b) => a - b)).toEqual(levels);
    expect(Object.keys(NATION_COMMAND_PERMISSIONS).sort()).toEqual(commands.map(({ key }) => key).sort());
    for (const { key, allowed } of commands)
      expect([...NATION_COMMAND_PERMISSIONS[key]].sort((a, b) => a - b)).toEqual([...allowed]);
    expect(APPOINTABLE_OFFICER_LEVELS).toEqual([11, 10, 9, 8, 7, 6, 5]);
    expect(nationCommandKeys(0)).toEqual([]);
    expect(nationCommandKeys(1)).toEqual([]);
  });

  const unknownLevels: unknown[] = [
    -1,
    2,
    3,
    4,
    13,
    5.5,
    11.5,
    12.1,
    Number.NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER,
    '0',
    '1',
    '5',
    '11',
    '12',
    '12.0',
    '0xC',
    '',
    null,
    undefined,
    true,
    false,
    [],
    {},
    [12],
    new Number(12),
    12n,
    Symbol('12'),
  ];
  it.each(unknownLevels.map((value, index) => ({ value, index })))(
    '비정상 직책 #$index는 이름·권한·임명을 모두 거부한다',
    ({ value }) => {
      expect(officerRole(value)).toBeNull();
      expect(officerTitle(value)).toBeNull();
      expect(canManagePersonnel(value)).toBe(false);
      expect(canUseNationTurns(value)).toBe(false);
      expect(isAppointableOfficerLevel(value)).toBe(false);
      expect(nationCommandKeys(value)).toEqual([]);
      for (const { key } of commands) expect(canExecuteNationCommand(value, key)).toBe(false);
    },
  );

  const unknownKeys: unknown[] = [
    '',
    'rest',
    'attack',
    'nation_appoint',
    'NATION_REWARD',
    'nation_reward ',
    ' nation_rest',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'prototype',
    0,
    1,
    12,
    Number.NaN,
    Infinity,
    null,
    undefined,
    true,
    false,
    [],
    {},
    ['nation_rest'],
    new String('nation_rest'),
    Symbol('nation_rest'),
  ];
  it.each(unknownKeys.map((value, index) => ({ value, index })))(
    '비정상 명령 #$index는 군주를 포함한 모든 직책에서 거부한다',
    ({ value }) => {
      for (const level of levels) expect(canExecuteNationCommand(level, value)).toBe(false);
    },
  );

  it('입력 객체를 읽거나 숫자·문자열로 강제 변환하지 않는다', () => {
    let coercions = 0;
    const input = Object.freeze({
      get officerLevel() {
        coercions++;
        throw new Error('입력 접근');
      },
      valueOf() {
        coercions++;
        return 12;
      },
      toString() {
        coercions++;
        return 'nation_rest';
      },
    });
    expect(officerRole(input)).toBeNull();
    expect(officerTitle(input)).toBeNull();
    expect(canManagePersonnel(input)).toBe(false);
    expect(canUseNationTurns(input)).toBe(false);
    expect(isAppointableOfficerLevel(input)).toBe(false);
    expect(nationCommandKeys(input)).toEqual([]);
    expect(canExecuteNationCommand(input, 'nation_rest')).toBe(false);
    expect(canExecuteNationCommand(12, input)).toBe(false);
    expect(coercions).toBe(0);
  });

  it('공개 표·중첩 배열과 반환 목록은 불변이며 변경 시도 뒤에도 권한이 같다', () => {
    expect(Object.isFrozen(OFFICER_ROLES)).toBe(true);
    expect(Object.isFrozen(NATION_COMMAND_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(APPOINTABLE_OFFICER_LEVELS)).toBe(true);
    expect(Reflect.set(OFFICER_ROLES, '0', {})).toBe(false);
    expect(Reflect.set(NATION_COMMAND_PERMISSIONS, 'unknown', [12])).toBe(false);
    expect(Reflect.set(APPOINTABLE_OFFICER_LEVELS, '0', 12)).toBe(false);
    for (const role of OFFICER_ROLES) {
      expect(Object.isFrozen(role)).toBe(true);
      expect(Object.isFrozen(role.levels)).toBe(true);
      expect(Object.isFrozen(role.commands)).toBe(true);
      expect(Reflect.set(role, 'managePersonnel', true)).toBe(false);
      expect(Reflect.set(role.levels, '0', 999)).toBe(false);
      expect(Reflect.set(role.commands, '0', 'unknown')).toBe(false);
    }
    for (const allowed of Object.values(NATION_COMMAND_PERMISSIONS)) {
      expect(Object.isFrozen(allowed)).toBe(true);
      expect(Reflect.set(allowed, '0', 999)).toBe(false);
    }
    for (const level of [...levels, 999]) expect(Object.isFrozen(nationCommandKeys(level))).toBe(true);
    expect(canExecuteNationCommand(12, 'nation_rest')).toBe(true);
    expect(canExecuteNationCommand(1, 'nation_rest')).toBe(false);
    expect(canExecuteNationCommand(12, 'unknown')).toBe(false);
    expect(officerTitle(12)).toBe('군주');
    expect(APPOINTABLE_OFFICER_LEVELS).toEqual([11, 10, 9, 8, 7, 6, 5]);
  });

  it('직책·명령·임명 가능 레벨의 타입도 원본 표 범위와 같다', () => {
    expectTypeOf<OfficerLevel>().toEqualTypeOf<0 | 1 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12>();
    expectTypeOf<AppointableOfficerLevel>().toEqualTypeOf<5 | 6 | 7 | 8 | 9 | 10 | 11>();
    expectTypeOf<NationCommandKey>().toEqualTypeOf<
      | 'nation_rest'
      | 'nation_reward'
      | 'nation_seize'
      | 'nation_assign'
      | 'nation_peace'
      | 'nation_pact'
      | 'nation_break_pact'
      | 'nation_aid'
      | 'nation_declare'
      | 'nation_capital'
    >();
  });
});
