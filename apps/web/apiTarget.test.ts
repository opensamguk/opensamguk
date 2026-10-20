import { describe, expect, it } from 'vitest';
import { resolveApiTarget } from './apiTarget';

describe('API 서버 주소', () => {
  it('아무 설정이 없으면 3001', () => {
    expect(resolveApiTarget({}, {})).toBe('http://127.0.0.1:3001');
  });

  it('루트 .env의 SERVER_PORT를 따른다', () => {
    expect(resolveApiTarget({}, { SERVER_PORT: '3005' })).toBe('http://127.0.0.1:3005');
  });

  it('프로세스 환경변수가 .env보다 우선한다 (server와 같은 규칙)', () => {
    expect(resolveApiTarget({ SERVER_PORT: '3002' }, { SERVER_PORT: '3005' })).toBe('http://127.0.0.1:3002');
  });

  it('올바르지 않은 포트는 거부한다', () => {
    expect(() => resolveApiTarget({ SERVER_PORT: 'abc' }, {})).toThrow('SERVER_PORT');
    expect(() => resolveApiTarget({ SERVER_PORT: '70000' }, {})).toThrow('SERVER_PORT');
  });
});
