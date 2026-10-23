import { describe, expect, it } from 'vitest';
import { commandWorld } from '../../test/commandFixture';
import { TICKS_PER_MONTH } from '../clock/constants';
import {
  choosePolicyCommand,
  INACTIVE_AFTER_DAYS,
  isInactive,
  isPolicyKey,
  normalizeSlot,
  POLICY_KEYS,
  policyOptions,
  sameSlot,
} from './index';

describe('AC-M2-17 기본 방침 순수 규칙', () => {
  it('방침 표는 승인된 순서와 명령 레지스트리 이름을 쓴다', () => {
    expect(policyOptions().map((p) => [p.key, p.name, p.emptyCommand.key, p.thenCommand?.key ?? null])).toEqual([
      ['farm', '권농', 'farm', null],
      ['commerce', '중상', 'commerce', null],
      ['security', '치안', 'security', null],
      ['defend', '수비', 'defence', 'wall'],
      ['drill', '훈련', 'train', 'morale'],
      ['none', '없음', 'rest', null],
    ]);
    expect(policyOptions()[0]!.emptyCommand.name).toBe('농지 개간');
    for (const value of ['attack', '__proto__', 'toString', null, 1, {}]) expect(isPolicyKey(value)).toBe(false);
    for (const key of POLICY_KEYS) expect(isPolicyKey(key)).toBe(true);
  });

  it.each([30, 60])('턴 간격 %i분인 월드는 진행 시간 14일을 초과해야 미접속이다', (minutes) => {
    const start = 1234;
    const threshold = ((INACTIVE_AFTER_DAYS * 1440) / minutes) * TICKS_PER_MONTH;
    expect(isInactive(start, start + threshold, minutes)).toBe(false);
    expect(isInactive(start, start + threshold + 1, minutes)).toBe(true);
    // 현실 시각이나 정지 시간은 입력에 없으며 tick이 같으면 결과도 같다.
    expect(isInactive(start, start, minutes)).toBe(false);
  });

  it('잘못된 활동 tick이나 턴 간격은 거부한다', () => {
    for (const args of [
      [-1, 1, 30],
      [2, 1, 30],
      [0, 1, 0],
      [0, 1, NaN],
    ])
      expect(() => isInactive(args[0]!, args[1]!, args[2]!)).toThrow();
  });

  it('사람 장수는 방침 범위의 내정·훈련·휴식만 고르고 NPC와 소유권을 바꾸지 않는다', () => {
    const world = commandWorld();
    world.generals[1]!.userId = 'human';
    const original = structuredClone(world);
    for (const key of POLICY_KEYS) {
      expect(['farm', 'commerce', 'security', 'defence', 'wall', 'train', 'morale', 'rest']).toContain(
        choosePolicyCommand(world, 1, key)?.commandKey,
      );
      expect(choosePolicyCommand(world, 2, key)).toBeNull();
    }
    expect(world).toEqual(original);
    expect(choosePolicyCommand(world, 999, 'farm')).toBeNull();
  });

  it('수비와 훈련은 선행 수치가 최대일 때만 다음 명령을 고른다', () => {
    const world = commandWorld();
    world.generals[1]!.userId = 'human';
    expect(choosePolicyCommand(world, 1, 'defend')?.commandKey).toBe('defence');
    world.cities[1]!.defence = world.cities[1]!.defenceMax;
    expect(choosePolicyCommand(world, 1, 'defend')?.commandKey).toBe('wall');
    world.generals[1]!.train = 99;
    expect(choosePolicyCommand(world, 1, 'drill')?.commandKey).toBe('train');
    world.generals[1]!.train = 100;
    expect(choosePolicyCommand(world, 1, 'drill')?.commandKey).toBe('morale');
  });

  it('빈칸과 직접 휴식을 구분하고 옛 휴식은 직접 휴식으로 보존한다', () => {
    const rest = normalizeSlot({ commandKey: 'rest', args: {} });
    const empty = { ...rest, explicit: false };
    expect(rest.explicit).toBe(true);
    expect(sameSlot(rest, empty)).toBe(false);
    expect(sameSlot(empty, { ...empty })).toBe(true);
    expect(sameSlot(rest, { ...rest })).toBe(true);
    expect(sameSlot(rest, { ...rest, commandKey: 'farm' })).toBe(false);
    const a = { commandKey: 'move', args: { a: [1, { x: 2, y: 3 }], b: null }, explicit: true };
    expect(sameSlot(a, { ...a, args: { b: null, a: [1, { y: 3, x: 2 }] } })).toBe(true);
    expect(sameSlot(a, { ...a, args: { b: null, a: [1, { y: 4, x: 2 }] } })).toBe(false);
  });
});
