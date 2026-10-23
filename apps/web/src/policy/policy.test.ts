import { describe, expect, it } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import type { PolicyOption, PolicyResponse } from './types';
import {
  directionParticle,
  emptySlotLabel,
  inactiveSentence,
  objectParticle,
  optionFor,
  policySentence,
  rejectionSentence,
} from './policyText';
import { policyPollMs, policyView, setPolicyErrorMessage } from './usePolicy';

// 응답은 AppRouter의 general.policy 출력 모양이다. 이름과 명령, 날 수는 서버가 준다. 가짜 값이라 API 증거가 아니다.
const option = (key: PolicyOption['key'], name: string, first: string, then: string | null = null) =>
  ({
    key,
    name,
    emptyCommand: { key: `${key}-cmd`, name: first },
    thenCommand: then ? { key: `${key}-then`, name: then } : null,
  }) satisfies PolicyOption;
const options = [
  option('farm', '권농', '농지 개간'),
  option('commerce', '중상', '상업 투자'),
  option('defend', '수비', '수비 강화', '성벽 보수'),
  option('drill', '훈련', '훈련', '사기진작'),
  option('none', '없음', '휴식'),
];
const response = (patch: Partial<PolicyResponse> = {}): PolicyResponse =>
  ({
    current: 'farm',
    pending: null,
    lastRejected: null,
    options,
    inactiveAfterDays: 14,
    ...patch,
  }) satisfies PolicyResponse;
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

  it('미접속 안내는 응답의 날 수로 월드 시간 기준과 직접 칸 유지, 빈 칸 범위를 적는다', () => {
    expect(inactiveSentence(response())).toBe(
      '정지한 시간을 빼고 월드 시간으로 14일 넘게 들어오지 않아도 직접 넣은 명령과 휴식은 그대로 하고 빈 칸만 기본 방침대로 합니다.',
    );
    expect(inactiveSentence(response({ inactiveAfterDays: 30 }))).toContain('월드 시간으로 30일 넘게');
  });

  it('빈 칸 표시는 확정된 방침을 따르고 방침이 없거나 모르면 빈 칸 휴식이다', () => {
    expect(emptySlotLabel(response())).toEqual({ tag: '권농', command: '농지 개간' });
    expect(emptySlotLabel(response({ current: 'commerce', pending: 'farm' }))).toEqual({
      tag: '중상',
      command: '상업 투자',
    });
    expect(emptySlotLabel(response({ current: 'none' }))).toEqual({ tag: '빈 칸', command: '휴식' });
    expect(emptySlotLabel(undefined)).toEqual({ tag: '빈 칸', command: '휴식' });
  });

  it('고르기 칸의 문자열은 서버가 준 방침일 때만 그 방침으로 읽는다', () => {
    expect(optionFor(response(), 'drill')?.key).toBe('drill');
    expect(optionFor(response(), 'security')).toBeUndefined();
    expect(optionFor(response(), 'attack')).toBeUndefined();
  });

  it('엔진 거절 코드 넷은 엔진 문장으로, 모르는 코드는 일반 실패 문장만 보인다', () => {
    const data = response();
    const reject = (reason: string) => rejectionSentence(data, { policy: 'drill', reason });
    expect(reject('WORLD_CLOSED')).toBe('훈련으로 바꾸지 못했습니다. 종료된 월드입니다.');
    expect(reject('ACTOR_INACTIVE')).toBe('훈련으로 바꾸지 못했습니다. 활성 계정이 아닙니다.');
    expect(reject('NO_GENERAL')).toBe('훈련으로 바꾸지 못했습니다. 내 장수가 아닙니다.');
    expect(reject('BAD_POLICY')).toBe('훈련으로 바꾸지 못했습니다. 활동·기본 방침 입력이 올바르지 않습니다.');
    expect(reject('SOMETHING_NEW')).toBe('방침을 바꾸지 못했습니다.');
    expect(reject('toString')).toBe('방침을 바꾸지 못했습니다.');
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

  it('거절되면 이유 코드를 남기고 고르기 칸을 지금 방침으로 되돌린다', () => {
    const rejected = { policy: 'drill' as const, reason: 'WORLD_CLOSED' };
    const view = policyView(response({ lastRejected: rejected }), { ...idle, asked: 'drill' });
    expect(view).toMatchObject({ selected: 'farm', processing: false, confirmed: false, rejected });
  });

  it('가장 최근 입력이 거절됐으면 거절된 방침이 current와 같아도 거절을 보이고 확정으로 보지 않는다', () => {
    const view = policyView(response({ current: 'drill', lastRejected: { policy: 'drill', reason: 'WORLD_CLOSED' } }), {
      ...idle,
      asked: 'drill',
    });
    expect(view).toEqual({
      selected: 'drill',
      processing: false,
      confirmed: false,
      rejected: { policy: 'drill', reason: 'WORLD_CLOSED' },
    });
  });

  it('거절 뒤 입력이 적용돼 서버가 lastRejected를 null로 주면 거절 안내 없이 확정이다', () => {
    const view = policyView(response({ current: 'drill', lastRejected: null }), { ...idle, asked: 'drill' });
    expect(view).toEqual({ selected: 'drill', processing: false, confirmed: true, rejected: null });
  });

  it('처리 중인 방침이 있을 때만 2초마다 다시 묻는다', () => {
    expect(policyPollMs(response({ pending: 'drill' }))).toBe(2_000);
    expect(policyPollMs(response())).toBe(false);
    expect(policyPollMs(undefined)).toBe(false);
  });

  it('서버 오류 코드를 안내로 바꾼다', () => {
    const error = (code: string, message: string) =>
      new TRPCClientError(message, { result: { error: { code: -1, message, data: { code } } } } as never);
    expect(setPolicyErrorMessage(error('UNAUTHORIZED', 'x'))).toEqual({ kind: 'auth' });
    expect(setPolicyErrorMessage(error('CONFLICT', 'x'))).toMatchObject({ kind: 'error' });
    expect(setPolicyErrorMessage(error('PRECONDITION_FAILED', '종료된 월드입니다.'))).toEqual({
      kind: 'error',
      message: '종료된 월드입니다.',
    });
    expect(setPolicyErrorMessage(new Error('network'))).toMatchObject({ kind: 'error' });
  });
});
