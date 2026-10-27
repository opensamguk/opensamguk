import { TRPCClientError } from '@trpc/client';
import { describe, expect, it } from 'vitest';
import { describeFailure, retryAfterSeconds, safeNext, validateCredentials } from './credentials';

describe('validateCredentials', () => {
  it('맞는 입력은 오류가 없다', () => {
    expect(validateCredentials(' a@b.kr ', 'x'.repeat(10))).toEqual({});
  });

  it('빈 칸과 형식 오류를 구분한다', () => {
    expect(validateCredentials('', '')).toEqual({ email: '이메일을 입력하세요', password: '비밀번호를 입력하세요' });
    expect(validateCredentials('a@b', 'x'.repeat(10)).email).toBe('이메일 형식이 맞지 않습니다');
  });

  it('비밀번호는 10~128자', () => {
    expect(validateCredentials('a@b.kr', 'x'.repeat(9)).password).toBe('비밀번호는 10~128자입니다');
    expect(validateCredentials('a@b.kr', 'x'.repeat(128)).password).toBeUndefined();
    expect(validateCredentials('a@b.kr', 'x'.repeat(129)).password).toBe('비밀번호는 10~128자입니다');
  });
});

describe('describeFailure', () => {
  const serverError = (code: string) => TRPCClientError.from({ error: { message: '', code: -32000, data: { code } } });

  it('서버 오류 코드를 문구로 바꾼다', () => {
    expect(describeFailure(serverError('UNAUTHORIZED'))).toEqual({
      kind: 'message',
      text: '이메일 또는 비밀번호가 맞지 않습니다',
    });
    expect(describeFailure(serverError('CONFLICT'))).toEqual({ kind: 'message', text: '이미 가입된 이메일입니다' });
  });

  it('응답을 못 받은 실패는 다시 시도', () => {
    expect(describeFailure(TRPCClientError.from(new TypeError('Failed to fetch')))).toEqual({ kind: 'retry' });
    expect(describeFailure(serverError('INTERNAL_SERVER_ERROR'))).toEqual({ kind: 'retry' });
  });
  it('공개 사유만 읽고 서버 문구나 cause를 쓰지 않는다', () => {
    const error = TRPCClientError.from({
      error: {
        message: 'private-server-message',
        code: -32000,
        data: { code: 'BAD_REQUEST', reason: 'TOKEN_INVALID' },
      },
    });
    expect(describeFailure(error)).toEqual({
      kind: 'message',
      text: '링크가 만료됐거나 이미 쓰였습니다. 새 링크를 요청하세요.',
    });
  });
  it.each(['45', '0', '-1', '1.5', 'later', '9007199254740992'])('Retry-After 정수 초만 읽는다(%s)', (header) => {
    const error = TRPCClientError.from(
      { error: { message: 'private-server-message', code: -32000, data: { code: 'TOO_MANY_REQUESTS', reason: null } } },
      { meta: { response: new Response(null, { headers: { 'Retry-After': header } }) } },
    );
    expect(retryAfterSeconds(error)).toBe(header === '45' ? 45 : null);
    expect(describeFailure(error)).toEqual({
      kind: 'message',
      text: header === '45' ? '45초 뒤에 다시 요청하세요.' : '잠시 뒤 다시 요청하세요.',
    });
  });
});

describe('safeNext', () => {
  it('같은 사이트 경로는 그대로', () => {
    expect(safeNext('/w/1/map?x=1')).toBe('/w/1/map?x=1');
  });

  it.each([
    undefined,
    '',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/login',
    '/signup?next=/w/1',
  ])('%j는 받지 않는다', (value) => {
    expect(safeNext(value)).toBeNull();
  });
});
