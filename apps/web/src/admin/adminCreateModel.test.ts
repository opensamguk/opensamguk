import { describe, expect, it } from 'vitest';
import {
  createFailurePhase,
  createPointer,
  freezeCreation,
  ownCreateReply,
  reviewCreation,
  storedText,
  type CreateReply,
} from './adminCreateModel';
import { draft, options, requestId, requestKey, viewerId, worldId } from './test/createFixture';
describe('AC-M3-04 생성 요청 확인·복구 경계', () => {
  it('자동 시드와 명시5자원·현재9기능을 고정하고 입력·키를 변경하지 않는다', () => {
    const original = JSON.stringify([options, draft]);
    const review = reviewCreation(options, draft, viewerId, 'one-seed');
    const command = freezeCreation(review, requestKey);
    expect(command.input).toMatchObject({
      expectedUserId: viewerId,
      name: '새 월드',
      seed: 'one-seed',
      idempotencyKey: requestKey,
      scenarioKey: 'integration191',
      mapKey: 'integration',
      statRulesKey: 'five-stats',
      portraitMapKey: '191-map',
      unitSetKey: 'basic',
      endYear: 201,
      turnTermMinutes: 60,
    });
    expect(command.input.ruleFeatures).toContain('city-resources-v1');
    expect(command.input.ruleFeatures).not.toContain('treaty-trade');
    expect(Object.isFrozen(command.input)).toBe(true);
    expect(Object.isFrozen(command.input.ruleFeatures)).toBe(true);
    expect(JSON.stringify([options, draft])).toBe(original);
  });
  it('직접 시드의 공백·Unicode와 endYear null을 그대로 보존한다', () => {
    const review = reviewCreation(
      options,
      { ...draft, endMode: 'none', seedMode: 'custom', seed: ' e\u0301 ' },
      viewerId,
      'ignored',
    );
    expect(review.input.seed).toBe(' e\u0301 ');
    expect(review.input.endYear).toBeNull();
  });
  it('현재 계정·현재 프리셋·지원 프로필이 아니면 생성하지 않는다', () => {
    for (const invalid of [
      { ...options, userId: worldId },
      { ...options, profiles: [] },
    ])
      expect(() => reviewCreation(invalid, draft, viewerId, 'seed')).toThrow();
    expect(() => reviewCreation(options, { ...draft, presetKey: 'not-current' }, viewerId, 'seed')).toThrow();
  });
  it('숫자의 지수·소수·범위 및 저장할 수 없는 문자열을 차단한다', () => {
    for (const turnTerm of ['0', '1.5', '1e2', '2147483648'])
      expect(() => reviewCreation(options, { ...draft, turnTerm }, viewerId, 'seed')).toThrow();
    for (const endYear of ['190', '10001', '2e2'])
      expect(() => reviewCreation(options, { ...draft, endYear }, viewerId, 'seed')).toThrow();
    for (const seed of ['', '\u0000', '\ud800']) expect(storedText(seed)).toBe(false);
    expect(storedText('한글🙂')).toBe(true);
  });
  it('완료 응답은 같은 계정·요청과 유효 월드만 받는다', () => {
    const pointer = { version: 1 as const, viewerId, idempotencyKey: requestKey, requestId };
    const reply: CreateReply = {
      userId: viewerId,
      idempotencyKey: requestKey,
      requestId,
      status: 'DONE',
      worldId,
      error: null,
    };
    expect(ownCreateReply(reply, pointer)).toBe(true);
    for (const patch of [
      { userId: worldId },
      { idempotencyKey: worldId },
      { requestId: worldId },
      { worldId: null },
      { status: 'PENDING' as const },
    ])
      expect(ownCreateReply({ ...reply, ...patch }, pointer)).toBe(false);
    expect(
      ownCreateReply(
        { ...reply, status: 'FAILED', worldId: null, error: { code: 'RESOURCE_INVALID', message: 'untrusted' } },
        pointer,
      ),
    ).toBe(true);
    expect(
      ownCreateReply(
        { ...reply, status: 'FAILED', worldId: null, error: { code: 'INTERNAL_UNKNOWN', message: 'untrusted' } },
        pointer,
      ),
    ).toBe(false);
  });
  it('최소 추적 포인터는 본인 UUID와 알려진 필드만 받는다', () => {
    const pointer = { version: 1, viewerId, idempotencyKey: requestKey };
    expect(createPointer(pointer, viewerId)).toEqual(pointer);
    for (const value of [
      null,
      [],
      { ...pointer, viewerId: worldId },
      { ...pointer, idempotencyKey: 'bad' },
      { ...pointer, seed: 'must-not-store' },
      { ...pointer, requestId: 'bad' },
    ])
      expect(createPointer(value, viewerId)).toBeNull();
  });
  it('미접수는 최초400만 확정하며 충돌·404·유실을 새 요청 허용으로 삼지 않는다', () => {
    expect(createFailurePhase('BAD_REQUEST', true)).toBe('notAccepted');
    expect(createFailurePhase('BAD_REQUEST', false)).toBe('unknown');
    for (const code of ['CONFLICT', 'NOT_FOUND', 'INTERNAL_SERVER_ERROR', undefined])
      expect(createFailurePhase(code, true)).toBe('unknown');
    expect(createFailurePhase('TOO_MANY_REQUESTS', true)).toBe('limited');
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN']) expect(createFailurePhase(code, false)).toBe('denied');
  });
});
