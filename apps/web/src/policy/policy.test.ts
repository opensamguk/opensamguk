import { describe, expect, it } from 'vitest';
import type { PolicyOption, PolicyResponse } from './contract';
import { directionParticle, emptySlotLabel, objectParticle, policySentence } from './policyText';
import { policyView, setPolicyErrorMessage } from './usePolicy';
import { TRPCClientError } from '@trpc/client';

// 응답은 docs/plans/T2-13.md의 PolicyResponse 모양이다. 이름과 명령은 서버가 준다.
const option = (key: PolicyOption['key'], name: string, first: string, then: string | null = null): PolicyOption => ({
  key,
  name,
  emptyCommand: { key: `${key}-cmd`, name: first },
  thenCommand: then ? { key: `${key}-then`, name: then } : null,
});
const options = [
  option('farm', '권농', '농지 개간'),
  option('commerce', '중상', '상업 투자'),
  option('defend', '수비', '수비 강화', '성벽 보수'),
  option('drill', '훈련', '훈련', '사기진작'),
  option('none', '없음', '휴식'),
];
const response = (patch: Partial<PolicyResponse> = {}): PolicyResponse => ({
  current: 'farm',
  pending: null,
  lastRejected: null,
  options,
  inactiveAfterDays: 14,
  ...patch,
});
const idle = { asked: null, sending: false, sendingPolicy: null };

describe('방침 문장', () => {
  it('받침에 맞춰 조사를 고른다', () => {
    expect(objectParticle('농지 개간')).toBe('을');
    expect(objectParticle('상업 투자')).toBe('를');
    expect(objectParticle('ABC')).toBe('을(를)');
    expect(directionParticle('권농')).toBe('으로');
    expect(directionParticle('수비')).toBe('로');
    expect(directionParticle('훈련')).toBe('으로');
    expect(directionParticle('보물')).toBe('로');
  });

  it('빈 칸이 할 명령과 최대일 때의 다음 명령, 실패하면 휴식을 적는다', () => {
    expect(policySentence(options[0])).toBe('빈 칸은 농지 개간을 합니다. 실패하면 휴식합니다.');
    expect(policySentence(options[2])).toBe(
      '빈 칸은 수비 강화를 합니다. 이미 최대면 성벽 보수를 합니다. 실패하면 휴식합니다.',
    );
    expect(policySentence(options[4])).toBe('빈 칸은 휴식합니다.');
    expect(policySentence(undefined)).toBe('빈 칸은 휴식합니다.');
  });

  it('빈 칸 표시는 확정된 방침을 따르고, 방침이 없거나 모르면 빈 칸 휴식이다', () => {
    expect(emptySlotLabel(response())).toEqual({ tag: '권농', command: '농지 개간' });
    expect(emptySlotLabel(response({ current: 'commerce', pending: 'farm' }))).toEqual({
      tag: '중상',
      command: '상업 투자',
    });
    expect(emptySlotLabel(response({ current: 'none' }))).toEqual({ tag: '빈 칸', command: '휴식' });
    expect(emptySlotLabel(undefined)).toEqual({ tag: '빈 칸', command: '휴식' });
  });
});

describe('방침 바꾸기 상태', () => {
  it('보내는 중에는 고른 값을 처리 중으로 둔다', () => {
    const view = policyView(response(), { asked: 'drill', sending: true, sendingPolicy: 'drill' });
    expect(view).toMatchObject({ selected: 'drill', processing: true, confirmed: false });
  });

  it('엔진이 아직 처리하지 않았으면 pending 값을 처리 중으로 둔다', () => {
    const view = policyView(response({ pending: 'drill' }), { ...idle, asked: 'drill' });
    expect(view).toMatchObject({ selected: 'drill', processing: true, confirmed: false });
  });

  it('pending이 null이 되고 current가 고른 값이면 확정이다', () => {
    const view = policyView(response({ current: 'drill' }), { ...idle, asked: 'drill' });
    expect(view).toMatchObject({ selected: 'drill', processing: false, confirmed: true, rejected: null });
  });

  it('거절되면 이유를 남기고 고르기 칸을 지금 방침으로 되돌린다', () => {
    const rejected = { policy: 'drill' as const, reason: '제재 중인 계정입니다.' };
    const view = policyView(response({ lastRejected: rejected }), { ...idle, asked: 'drill' });
    expect(view).toMatchObject({ selected: 'farm', processing: false, confirmed: false, rejected });
  });

  it('거절된 방침이 나중에 확정됐으면 거절 안내를 지운다', () => {
    const view = policyView(response({ current: 'drill', lastRejected: { policy: 'drill', reason: 'x' } }), idle);
    expect(view.rejected).toBeNull();
  });

  it('서버 오류 코드를 안내로 바꾼다', () => {
    const error = (code: string, message: string) =>
      new TRPCClientError(message, { result: { error: { code: -1, message, data: { code } } } } as never);
    expect(setPolicyErrorMessage(error('UNAUTHORIZED', 'x'))).toEqual({ kind: 'auth' });
    expect(setPolicyErrorMessage(error('CONFLICT', 'x'))).toMatchObject({ kind: 'error' });
    expect(setPolicyErrorMessage(error('FORBIDDEN', '제재 중입니다.'))).toEqual({
      kind: 'error',
      message: '제재 중입니다.',
    });
    expect(setPolicyErrorMessage(new Error('network'))).toMatchObject({ kind: 'error' });
  });
});
