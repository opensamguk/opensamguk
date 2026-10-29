import { describe, expect, it } from 'vitest';
import { LOAD_CONTRACT, LOAD_FEATURES, LOAD_FIXTURE_POLICY, loadDatabaseName, loadWorldPlans } from './contract';
import { LoadHttpClient, LoadHttpError, loadOrigin, type LoadInput } from './http';

const runId = '1234567890abcdef1234567890abcdef';

describe('T3-11 정식 부하 계약', () => {
  it('600장수와100접속을218계정·서로다른109명씩으로 준비한다', () => {
    const plans = loadWorldPlans(runId);
    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.turnTermMinutes)).toEqual([1, 2]);
    expect(new Set(plans.map((plan) => plan.seed)).size).toBe(2);
    const names = plans.flatMap((plan) => plan.humanNames);
    expect(names).toHaveLength(218);
    expect(new Set(names).size).toBe(218);
    for (const plan of plans) expect(plan.humanNames.length + LOAD_CONTRACT.historicalGenerals).toBe(600);
    expect(LOAD_CONTRACT.usersPerWorld * plans.length).toBe(100);
    expect(LOAD_CONTRACT.warmupMs).toBe(120_000);
    expect(LOAD_CONTRACT.measurementMs).toBe(900_000);
    expect(LOAD_FEATURES).toContain('city-resources-v1');
  });

  it('생략한runId나타DB이름을받지않는다', () => {
    expect(loadDatabaseName(runId)).toBe(`opensamguk_load_${runId}_test`);
    for (const value of ['', 'main', '../test', runId.toUpperCase(), `${runId}x`])
      expect(() => loadDatabaseName(value)).toThrow('LOAD_RUN_ID_INVALID');
  });

  it('정책고정물이운영승인으로표현되지않는다', () => {
    expect(LOAD_FIXTURE_POLICY.terms.version).toBe('load-fixture-v1');
    expect(LOAD_FIXTURE_POLICY.privacy.version).toBe('load-fixture-v1');
    expect(LOAD_FIXTURE_POLICY.terms.bodyText).toContain('운영 정책이 아닙니다');
    expect(Object.isFrozen(LOAD_FIXTURE_POLICY.terms)).toBe(true);
  });
});

describe('부하 HTTP 경계', () => {
  it('loopback또는전용compose server만허용한다', () => {
    for (const origin of ['http://127.0.0.1:3100', 'http://localhost:3100', 'http://server:3100'])
      expect(loadOrigin(origin)).toBe(origin);
    for (const origin of [
      'https://example.com',
      'http://127.0.0.1/',
      'http://user:secret@localhost',
      'file:///tmp/test',
      'invalid',
      'http://localhost?key=secret',
    ])
      expect(() => loadOrigin(origin)).toThrow(/LOAD_/);
  });

  it('클라이언트JSON이나오류에쿠키원문을남기지않는다', () => {
    const token = 'x'.repeat(43);
    const client = new LoadHttpClient('http://127.0.0.1:3100', 'http://127.0.0.1:5173', token);
    expect(JSON.stringify(client).includes(token)).toBe(false);
    expect(Object.values(client)).toEqual([]);
    expect(() => new LoadHttpClient('http://127.0.0.1', 'http://127.0.0.1', 'bad')).toThrow('LOAD_SESSION_INVALID');
    const failure = new LoadHttpError('general.create', 403);
    expect(failure.message).toBe('LOAD_HTTP_REQUEST_FAILED');
    expect(failure.status).toBe(403);
  });

  it('실제AppRouter입력의canonical intel·30칸계약을사용한다', () => {
    const create: LoadInput<'general.create'> = {
      worldId: '00000000-0000-4000-8000-000000000001',
      name: '부하1001',
      leadership: 55,
      strength: 55,
      intel: 55,
      politics: 55,
      charm: 55,
      portraitId: null,
    };
    const turns: LoadInput<'turns.set'> = {
      worldId: create.worldId,
      revision: 0,
      slots: Array.from({ length: 30 }, () => null),
    };
    expect(create.intel).toBe(55);
    expect(turns.slots).toHaveLength(30);
  });
});
