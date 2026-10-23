import { describe, expect, it } from 'vitest';
import { hashState } from '@opensamguk/shared/node';
import {
  checkContent,
  makeLimits,
  measureJson,
  MAX_CONTENT_DEPTH,
  RESULT_FIELD_ALLOWANCE_BYTES,
  RESOURCE_PAYLOAD_LIMITS,
  type Limits,
} from './payload';

function limits(overrides: Partial<Limits> = {}): Limits {
  const value = { depthMax: MAX_CONTENT_DEPTH, contentMax: 4096, metaMax: 32, ...overrides };
  return makeLimits({
    ...value,
    responseMax: overrides.responseMax ?? value.contentMax + value.metaMax + RESULT_FIELD_ALLOWANCE_BYTES,
  });
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('자원 JSON 예산', () => {
  it('준비 상수와 get 필드 여유는 단일 결과 예산 안이고 wire 한도를 주장하지 않는다', () => {
    expect(RESOURCE_PAYLOAD_LIMITS).toEqual({
      depthMax: 16,
      contentMax: 131_072,
      metaMax: 8192,
      responseMax: 134_217_728,
    });
    expect(
      RESOURCE_PAYLOAD_LIMITS.contentMax * 1000 +
        1024 * 1000 +
        RESOURCE_PAYLOAD_LIMITS.metaMax +
        RESULT_FIELD_ALLOWANCE_BYTES,
    ).toBeLessThanOrEqual(RESOURCE_PAYLOAD_LIMITS.responseMax);
    expect(bytes({ meta: null, content: null }) - bytes(null) * 2).toBeLessThanOrEqual(RESULT_FIELD_ALLOWANCE_BYTES);
    expect(bytes({ ok: false, reason: 'RESPONSE_TOO_LARGE' })).toBeLessThanOrEqual(RESULT_FIELD_ALLOWANCE_BYTES);
  });

  it('makeLimits는 get 결과 칸의 여유를 포함하고 입력을 바꾸지 않는다', () => {
    const input = { depthMax: 16, contentMax: 100, metaMax: 20, responseMax: 184 };
    const result = makeLimits(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => makeLimits({ ...input, responseMax: 183 })).toThrow('invalid_resource_limits');
  });

  it.each(['depthMax', 'contentMax', 'metaMax', 'responseMax'] as const)('%s는 양의 안전한 정수만 받는다', (field) => {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => makeLimits({ ...limits(), [field]: value })).toThrow('invalid_resource_limits');
    }
  });

  it('재귀 검사 전에 쓸 깊이와 예산 덧셈 범위를 제한한다', () => {
    expect(() => makeLimits({ ...limits(), depthMax: MAX_CONTENT_DEPTH + 1 })).toThrow('invalid_resource_limits');
    expect(() =>
      makeLimits({
        depthMax: 1,
        contentMax: Number.MAX_SAFE_INTEGER,
        metaMax: 1,
        responseMax: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow('invalid_resource_limits');
  });

  it.each(['', '가😀', '"\\\b\f\n\r\t', '\u0000\u001f', '\u2028\u2029', '\ud800', '\udfff', 'a\ud800b\udfffc😀'])(
    '문자열 %j의 JSON 이스케이프와 UTF-8 길이를 맞힌다',
    (text) => {
      const value = { [text]: [text, text] };
      expect(measureJson(value, bytes(value))).toEqual({ ok: true, bytes: bytes(value) });
      expect(measureJson(value, bytes(value) - 1)).toEqual({ ok: false });
    },
  );

  it.each([null, true, false, 0, -0, 0.25, 1e-7, 1e21, Number.MAX_VALUE, [], {}, [null, false, 3]])(
    'JSON 값 %j의 정확한 바이트를 센다',
    (value) => {
      expect(measureJson(value, bytes(value))).toEqual({ ok: true, bytes: bytes(value) });
      expect(measureJson(value, bytes(value) - 1)).toEqual({ ok: false });
    },
  );

  it('컨테이너 구분자와 빈 키도 예산에 넣는다', () => {
    for (const value of [{ '': 0 }, { '': null, a: [] }, { a: { b: [1, { '': true }] } }, [0, 0, 0]]) {
      expect(measureJson(value, bytes(value))).toEqual({ ok: true, bytes: bytes(value) });
    }
  });

  it.each([0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('잘못된 측정 예산 %s는 고정 실패다', (max) => {
    expect(measureJson({}, max)).toEqual({ ok: false });
  });
});

describe('저장할 자원 내용 선검사', () => {
  it('원문과 모르는 JSON 필드를 보존하고 해시하지 않을 정규화를 만들지 않는다', () => {
    const value = Object.freeze({ z: Object.freeze({ extra: '남길 값' }), a: Object.freeze([1, true, null]) });
    const result = checkContent(value, limits());
    expect(result).toEqual({ ok: true, content: value, bytes: bytes(value) });
    if (!result.ok) throw new Error('검사 통과가 필요합니다.');
    expect(result.content).toBe(value);
    expect(hashState(result.content)).toBe(hashState(value));
    expect(hashState({ a: value.a })).not.toBe(hashState(result.content));
  });

  it('null 원형 객체와 키 순서가 다른 객체의 JSON·정규 해시 바이트 길이는 같다', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: '가',
      10: '열',
      2: '둘',
      a: [1, false],
    });
    const reordered = { a: [1, false], 2: '둘', 10: '열', z: '가' };
    expect(checkContent(value, limits())).toEqual({ ok: true, content: value, bytes: bytes(value) });
    expect(bytes(value)).toBe(bytes(reordered));
    expect(hashState(value)).toBe(hashState(reordered));
  });

  it('컨테이너 루트가 1단이고 scalar는 깊이를 더하지 않는다', () => {
    expect(checkContent({ a: 1 }, limits({ depthMax: 1 })).ok).toBe(true);
    expect(checkContent({ a: {} }, limits({ depthMax: 1 }))).toEqual({ ok: false });
    expect(checkContent({ a: [{}] }, limits({ depthMax: 3 })).ok).toBe(true);
    expect(checkContent({ a: [{ b: {} }] }, limits({ depthMax: 3 }))).toEqual({ ok: false });
  });

  it('최대 깊이 경계와 그 다음 컨테이너를 구분한다', () => {
    let value: Record<string, unknown> = {};
    for (let depth = 1; depth < MAX_CONTENT_DEPTH; depth++) value = { a: value };
    expect(checkContent(value, limits()).ok).toBe(true);
    expect(checkContent({ a: value }, limits())).toEqual({ ok: false });
  });

  it('아주 깊은 값과 순환 값이 재귀 검사에 들어가지 않는다', () => {
    let value: Record<string, unknown> = {};
    for (let depth = 0; depth < 20_000; depth++) value = { a: value };
    expect(checkContent(value, limits())).toEqual({ ok: false });
    expect(measureJson(value, 64)).toEqual({ ok: false });
    const cyclic: Record<string, unknown> = {};
    cyclic.a = cyclic;
    expect(checkContent(cyclic, limits())).toEqual({ ok: false });
    expect(measureJson(cyclic, 4096)).toEqual({ ok: false });
  });

  it('공유하는 하위 객체는 순환으로 보지 않고 각 위치의 바이트를 센다', () => {
    const shared = { a: ['같은 값'] };
    const value = { left: shared, right: shared };
    expect(checkContent(value, limits())).toEqual({ ok: true, content: value, bytes: bytes(value) });
  });

  it('여러 바이트 값의 contentMax와 contentMax+1을 구분한다', () => {
    const value = { '키😀': '가😀"\n' };
    const cap = bytes(value);
    expect(checkContent(value, limits({ contentMax: cap })).ok).toBe(true);
    expect(checkContent({ '키😀': value['키😀'] + 'x' }, limits({ contentMax: cap }))).toEqual({ ok: false });
    expect(checkContent(value, limits({ contentMax: cap - 1 }))).toEqual({ ok: false });
  });

  it.each([undefined, null, 1, true, '글', [], new Date(0), new Map(), Object.create({ inherited: 1 })])(
    '객체 자원 루트가 아닌 %j를 거부한다',
    (value) => {
      expect(checkContent(value, limits())).toEqual({ ok: false });
    },
  );

  it.each([undefined, () => 1, 1n, Symbol('표식'), new Map(), new Date(0), NaN, Infinity, -0])(
    '저장할 수 없는 하위 값 %s를 거부한다',
    (value) => {
      expect(checkContent({ value }, limits())).toEqual({ ok: false });
    },
  );

  it.each(['\u0000', '\ud800', '\udfff', 'x\ud800y'])('저장할 수 없는 문자열 %j를 키와 값에서 거부한다', (value) => {
    expect(checkContent({ value }, limits())).toEqual({ ok: false });
    expect(checkContent({ [value]: 1 }, limits())).toEqual({ ok: false });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('예약 키 %s는 실제 own data property일 때 거부한다', (key) => {
    const value = JSON.parse(`{"${key}":1}`) as unknown;
    expect(checkContent(value, limits())).toEqual({ ok: false });
  });

  it('accessor와 toJSON은 호출하지 않고 실패한다', () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'token', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('private-marker');
      },
    });
    const toJSON = {
      toJSON() {
        calls++;
        return 'private-marker';
      },
    };
    for (const value of [accessor, toJSON]) {
      expect(checkContent(value, limits())).toEqual({ ok: false });
      expect(measureJson(value, 4096)).toEqual({ ok: false });
    }
    expect(calls).toBe(0);
  });

  it('Proxy의 trap과 revoked Proxy를 실행하지 않는다', () => {
    let traps = 0;
    const value = new Proxy(
      {},
      {
        ownKeys() {
          traps++;
          throw new Error('private-marker');
        },
        getPrototypeOf() {
          traps++;
          return null;
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const proxy of [value, revoked.proxy]) {
      expect(checkContent(proxy, limits())).toEqual({ ok: false });
      expect(measureJson(proxy, 4096)).toEqual({ ok: false });
    }
    expect(traps).toBe(0);
  });

  it('숨은 칸·symbol 키·빈 배열 칸·추가 배열 칸·배열 하위형을 거부한다', () => {
    const hidden = Object.defineProperty({}, 'hidden', { value: 1 });
    const symbol = { [Symbol('private-marker')]: 1 };
    const extra = Object.assign([1], { extra: 1 });
    class CustomArray extends Array<number> {}
    const sparse = new Array(2);
    for (const value of [hidden, symbol, extra, new CustomArray(1), sparse]) {
      expect(checkContent({ value }, limits())).toEqual({ ok: false });
      expect(measureJson(value, 4096)).toEqual({ ok: false });
    }
  });

  it('엄청 긴 문자열·희소 배열을 예산에서 거부하고 값이나 키를 실패에 싣지 않는다', () => {
    const values = [{ 'private-marker': '가'.repeat(100_000) }, { value: new Array(0xffff_ffff) }];
    for (const value of values) {
      const result = checkContent(value, limits({ contentMax: 32 }));
      expect(result).toEqual({ ok: false });
      expect(JSON.stringify(result)).not.toContain('private-marker');
    }
  });
});
