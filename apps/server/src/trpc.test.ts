import { getTRPCErrorShape, TRPCError, type inferRouterError } from '@trpc/server';
import { expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { appRouter, type AppRouter } from './router';
import { PUBLIC_ERROR_REASONS, PublicReasonError, type PublicErrorReason } from './trpc';

const privateMessage = 'internal-account-token-detail';
function format(error: TRPCError) {
  error.stack = privateMessage;
  return getTRPCErrorShape({
    config: appRouter._def._config,
    error,
    type: 'mutation',
    path: 'account.test',
    input: undefined,
    ctx: undefined,
  });
}
function noPrivateFields(value: unknown) {
  const json = JSON.stringify(value);
  for (const forbidden of ['"cause"', '"stack"', privateMessage]) expect(json.includes(forbidden)).toBe(false);
}

it.each(PUBLIC_ERROR_REASONS)('명시적 공개 예외 %s만 사유에 싣고 기존 오류 코드를 유지한다', (reason) => {
  const code = reason === 'TOKEN_INVALID' ? 'BAD_REQUEST' : 'FORBIDDEN';
  const cause = new PublicReasonError(reason);
  cause.message = privateMessage;
  const shape = format(new TRPCError({ code, message: '요청을 확인하세요.', cause }));
  expect(shape.data).toEqual({ code, httpStatus: code === 'BAD_REQUEST' ? 400 : 403, path: 'account.test', reason });
  expect(shape.code).toBe(code === 'BAD_REQUEST' ? -32600 : -32003);
  expect(shape.message).toBe('요청을 확인하세요.');
  noPrivateFields(shape);
});

it.each([
  ['문자열', privateMessage],
  ['일반 Error', new Error(privateMessage)],
  ['사유를 흉내 낸 객체', { reason: 'EMAIL_NOT_VERIFIED', message: privateMessage }],
  ['사유를 흉내 낸 Error', Object.assign(new Error(privateMessage), { reason: 'CONSENT_REQUIRED' })],
  ['Zod 오류', new z.ZodError([])],
  ['사유 없음', undefined],
  ['허용하지 않은 인스턴스 값', new PublicReasonError('INTERNAL_ONLY' as PublicErrorReason)],
] as const)('%s는 공개 사유로 해석하지 않는다', (_name, cause) => {
  const shape = format(new TRPCError({ code: 'BAD_REQUEST', message: '입력을 확인하세요.', cause }));
  expect(shape.data).toEqual({ code: 'BAD_REQUEST', httpStatus: 400, path: 'account.test', reason: null });
  noPrivateFields(shape);
});

it('내부 오류 메시지는 계속 가리고 새 필드가 내부 원인을 노출하지 않는다', () => {
  const shape = format(
    new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: privateMessage, cause: new Error(privateMessage) }),
  );
  expect(shape.message).toBe('요청을 처리하지 못했습니다.');
  expect(shape.data).toEqual({ code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'account.test', reason: null });
  expect(shape.code).toBe(-32603);
  noPrivateFields(shape);
});

it('화면에서 추론하는 사유 타입은 승인한 3종과 null이다', () => {
  expect(PUBLIC_ERROR_REASONS).toEqual(['EMAIL_NOT_VERIFIED', 'CONSENT_REQUIRED', 'TOKEN_INVALID']);
  expectTypeOf<inferRouterError<AppRouter>['data']['reason']>().toEqualTypeOf<
    'EMAIL_NOT_VERIFIED' | 'CONSENT_REQUIRED' | 'TOKEN_INVALID' | null
  >();
});
