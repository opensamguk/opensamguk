import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resourceRoot } from './resourceRoot';

describe('T2-15 AC-M2-08 자료 루트', () => {
  it('개발 기본값과 명시 절대 경로가 같은 자료 파일을 가리킨다', () => {
    const expected = new URL('../../../../resources/', import.meta.url);
    expect(resourceRoot({})).toEqual(expected);
    expect(resourceRoot({ NODE_ENV: 'production', OPENSAMGUK_RESOURCES_ROOT: fileURLToPath(expected) })).toEqual(
      expected,
    );
  });
  it.each([
    { NODE_ENV: 'production' },
    { OPENSAMGUK_RESOURCES_ROOT: '' },
    { OPENSAMGUK_RESOURCES_ROOT: 'resources' },
    { OPENSAMGUK_RESOURCES_ROOT: fileURLToPath(import.meta.url) },
    { OPENSAMGUK_RESOURCES_ROOT: fileURLToPath(new URL('./missing-directory/', import.meta.url)) },
  ])('설정 오류를 경로 원문 없이 거부한다: %j', (env) => {
    expect(() => resourceRoot(env)).toThrow('OPENSAMGUK_RESOURCES_ROOT에 자료 디렉터리의 절대 경로를 지정하세요.');
  });
});
