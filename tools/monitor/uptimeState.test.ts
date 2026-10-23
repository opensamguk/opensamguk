import { describe, expect, it } from 'vitest';
import {
  acknowledge,
  initialState,
  nextDelivery,
  observe,
  recordAttemptFailure,
  restoreState,
  serializeState,
  UPTIME_LIMITS,
} from './uptimeState.js';
import type { Observation, PendingNotice, UptimeState } from './uptimeState.js';

const NOW = Date.parse('2026-10-24T00:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (offset = 0): string => new Date(NOW + offset).toISOString();

function input(runId: string, overrides: Partial<Observation> = {}): Observation {
  return { key: 'prod', runId, runAttempt: '1', now: NOW, ok: false, webhookConfigured: true, ...overrides };
}

function downState(): UptimeState {
  return observe(observe(initialState(), input('1')).state, input('2')).state;
}

function restored(raw: string | null, now = NOW, key = 'prod') {
  const result = restoreState({ key, raw, now });
  if ('error' in result) throw new Error(result.error);
  return result;
}

function delivered(): UptimeState {
  const state = downState();
  return acknowledge(state, { id: state.pending[0]!.id, now: NOW }).state;
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

describe('가동 확인 관측', () => {
  it('서로 다른 실패 두 번이 장애 한 건을 만들고 같은 입력의 계산 결과는 같다', () => {
    const start = frozen(initialState());
    const first = observe(start, input('1'));
    expect(first).toMatchObject({
      result: 'applied',
      counted: true,
      added: [],
      state: { consecutiveFailures: 1, alerting: false },
    });
    const second = observe(frozen(first.state), input('2', { runAttempt: '3' }));
    expect(second).toMatchObject({
      result: 'applied',
      counted: true,
      suppressed: null,
      dropped: [],
      state: { consecutiveFailures: 2, alerting: true, lastAlertAt: iso(), updatedAt: iso(), lastRunId: '2' },
    });
    expect(second.added).toEqual([
      { id: 'prod:down:2.3', kind: 'down', decidedAt: iso(), decidedRunId: '2', attempts: 0, lastAttemptAt: null },
    ]);
    expect(second.state.pending).toEqual(second.added);
    expect(observe(first.state, input('2', { runAttempt: '3' }))).toEqual(second);
    expect(first.state.pending).toEqual([]);
  });

  it('실패 사이의 성공은 실패 횟수를 지운다', () => {
    let state = observe(initialState(), input('1')).state;
    state = observe(state, input('2', { ok: true })).state;
    state = observe(state, input('3')).state;
    expect(state).toMatchObject({ consecutiveFailures: 1, alerting: false, pending: [], lastRecoveryAt: null });
  });

  it.each([
    ['2', '1', false],
    ['2', '2', false],
    ['2', '3', true],
    ['1', '1', false],
    ['1', '2', true],
  ])('실행 %s 시도 %s 성공 %s는 적용된 실행보다 새롭지 않으면 상태 바이트를 보존한다', (runId, runAttempt, ok) => {
    const state = frozen(downState());
    const bytes = serializeState(state);
    const result = observe(state, input(runId, { runAttempt, ok, now: NOW + DAY + 1 }));
    expect(result).toEqual({ result: 'skipped', state, counted: false, added: [], suppressed: null, dropped: [] });
    expect(result.state).toBe(state);
    expect(serializeState(result.state)).toBe(bytes);
  });

  it.each([false, true])('다른 실행이 끼어도 오래된 결과를 적용하지 않는다: 성공 %s', (ok) => {
    const state = observe(observe(initialState(), input('10')).state, input('20')).state;
    for (const runId of ['10', '15', '20']) {
      expect(observe(state, input(runId, { runAttempt: '2', ok })).result).toBe('skipped');
    }
    const next = observe(state, input('21', { ok: true }));
    expect(next.added.map((item) => item.kind)).toEqual(['recovery']);
    expect(next.state.alerting).toBe(false);
  });

  it('ack된 옛 실행 ID를 다시 알림으로 만들지 않는다', () => {
    const state: UptimeState = {
      ...delivered(),
      lastRunId: '20',
      lastAlertAt: iso(-30 * MINUTE),
      lastDelivered: { id: 'prod:down:10.1', kind: 'down', at: iso() },
    };
    expect(restored(serializeState(state)).state).toEqual(state);
    expect(observe(state, input('10'))).toMatchObject({ result: 'skipped', added: [], state: { pending: [] } });
  });

  it.each([
    ['9', '10'],
    ['9007199254740992', '9007199254740993'],
  ])('실행 ID %s와 %s를 숫자 순서로 비교한다', (lower, higher) => {
    const state = observe(initialState(), input(lower)).state;
    const next = observe(state, input(higher));
    expect(next.result).toBe('applied');
    expect(observe(next.state, input(lower)).result).toBe('skipped');
  });

  it('장애가 포화돼도 새 실행은 메타데이터를 바꾼다', () => {
    const state = downState();
    const result = observe(state, input('3'));
    expect(result).toMatchObject({ result: 'applied', counted: true, added: [], state: { consecutiveFailures: 2 } });
    expect(serializeState(result.state)).not.toBe(serializeState(state));
  });

  it.each([
    [30 * MINUTE - 1, 0],
    [30 * MINUTE, 1],
    [30 * MINUTE + 1, 1],
  ])('재알림 %sms 경계에서 %s건을 만든다', (elapsed, count) => {
    const result = observe(delivered(), input('3', { now: NOW + elapsed }));
    expect(result.added).toHaveLength(count);
    expect(result.state.lastAlertAt).toBe(count ? iso(elapsed) : iso());
  });

  it('맨 뒤 장애가 남으면 재알림과 알림 시각 변경을 억제한다', () => {
    const state = downState();
    const result = observe(state, input('3', { now: NOW + 30 * MINUTE }));
    expect(result).toMatchObject({ suppressed: 'pending_down', added: [], state: { lastAlertAt: iso() } });
    expect(result.state.pending).toEqual(state.pending);
  });

  it('장애와 회복을 판정 순서로 남기고 회복 뒤 재장애도 유지한다', () => {
    let state = downState();
    state = observe(state, input('3', { ok: true })).state;
    expect(state.pending.map((item) => item.kind)).toEqual(['down', 'recovery']);
    state = acknowledge(state, { id: state.pending[0]!.id, now: NOW }).state;
    state = observe(state, input('4')).state;
    state = observe(state, input('5')).state;
    expect(state.pending.map((item) => item.kind)).toEqual(['recovery', 'down']);
    expect(nextDelivery(state, { now: NOW })?.kind).toBe('recovery');
  });

  it('다섯 번째 항목을 넣을 때 가장 오래된 항목만 버린다', () => {
    let state = downState();
    for (const [runId, ok] of [
      ['3', true],
      ['4', false],
      ['5', false],
      ['6', true],
      ['7', false],
    ] as const) {
      state = observe(state, input(runId, { ok })).state;
    }
    expect(state.pending).toHaveLength(4);
    const result = observe(state, input('8'));
    expect(result.dropped).toEqual([{ id: 'prod:down:2.1', reason: 'cap' }]);
    expect(result.state.pending.map((item) => item.id)).toEqual([
      'prod:recovery:3.1',
      'prod:down:5.1',
      'prod:recovery:6.1',
      'prod:down:8.1',
    ]);
    expect(restored(serializeState(result.state)).state).toEqual(result.state);
  });

  it.each([
    [DAY, false],
    [DAY + 1, true],
  ])('보관 %sms 경계에서 만료 여부는 %s다', (elapsed, expired) => {
    const state = downState();
    expect(nextDelivery(state, { now: NOW + elapsed }) === null).toBe(expired);
    const result = observe(state, input('3', { now: NOW + elapsed, ok: true, webhookConfigured: false }));
    expect(result.dropped).toEqual(expired ? [{ id: 'prod:down:2.1', reason: 'ttl' }] : []);
    expect(result.state.pending).toHaveLength(expired ? 0 : 1);
  });

  it('웹훅이 없어도 장애·회복 판정 필드는 바꾸고 항목만 생략한다', () => {
    let state = observe(initialState(), input('1', { webhookConfigured: false })).state;
    const down = observe(state, input('2', { webhookConfigured: false }));
    expect(down).toMatchObject({
      suppressed: 'no_webhook',
      added: [],
      state: { consecutiveFailures: 2, alerting: true, pending: [] },
    });
    state = down.state;
    const reminder = observe(state, input('3', { webhookConfigured: false, now: NOW + 30 * MINUTE }));
    expect(reminder).toMatchObject({ suppressed: 'no_webhook', state: { lastAlertAt: iso(30 * MINUTE) } });
    const recovery = observe(
      reminder.state,
      input('4', { webhookConfigured: false, now: NOW + 30 * MINUTE, ok: true }),
    );
    expect(recovery).toMatchObject({
      suppressed: 'no_webhook',
      added: [],
      state: { consecutiveFailures: 0, alerting: false, lastRecoveryAt: iso(30 * MINUTE), pending: [] },
    });
  });

  it('웹훅이 없어도 기존 미전송 항목은 보존한다', () => {
    const state = downState();
    const result = observe(state, input('3', { ok: true, webhookConfigured: false }));
    expect(result.suppressed).toBe('no_webhook');
    expect(result.state.pending).toEqual(state.pending);
  });

  it('prod와 drill 키는 각자 복원하고 같은 실행의 알림 ID가 다르다', () => {
    const first = observe(initialState(), input('1')).state;
    const prod = observe(first, input('2')).state;
    const drill = observe(first, input('2', { key: 'drill-local' })).state;
    expect(drill.pending[0]!.id).toBe('drill-local:down:2.1');
    expect(restored(serializeState(drill), NOW, 'drill-local').state).toEqual(drill);
    expect(restored(serializeState(prod), NOW, 'drill-local').warnings).toEqual([
      { code: 'invalid_schema', field: 'pending[0].id' },
    ]);
  });
});

describe('가동 확인 전달 전이', () => {
  it('실패 횟수는 관측 시도 번호와 별개이고 재시작 뒤 같은 항목을 인계한다', () => {
    const state = frozen(downState());
    const id = state.pending[0]!.id;
    let next = recordAttemptFailure(state, { id, now: NOW + 1 }).state;
    next = restored(serializeState(next), NOW + 1).state;
    next = recordAttemptFailure(next, { id, now: NOW + 2 }).state;
    expect(nextDelivery(next, { now: NOW + 2 })).toEqual({ ...state.pending[0], attempts: 2, lastAttemptAt: iso(2) });
    expect(next.lastRunId).toBe('2');
    expect(next.updatedAt).toBe(iso());
    expect(state.pending[0]!.attempts).toBe(0);
  });

  it('ack는 맨 앞만 지우고 같은 ack는 다시 바꾸지 않는다', () => {
    const state = frozen(observe(downState(), input('3', { ok: true })).state);
    const id = state.pending[0]!.id;
    const result = acknowledge(state, { id, now: NOW + 1 });
    expect(result).toMatchObject({ result: 'removed', state: { lastDelivered: { id, kind: 'down', at: iso(1) } } });
    expect(result.state.pending).toEqual([state.pending[1]]);
    expect(acknowledge(result.state, { id, now: NOW + 1 })).toEqual({ result: 'already_removed', state: result.state });
    expect(restored(serializeState(result.state), NOW + 1).state).toEqual(result.state);
  });

  it('다른 항목을 먼저 완료하거나 실패로 세지 않는다', () => {
    const state = frozen(observe(downState(), input('3', { ok: true })).state);
    const id = state.pending[1]!.id;
    expect(acknowledge(state, { id, now: NOW })).toEqual({ result: 'not_head', state });
    expect(recordAttemptFailure(state, { id, now: NOW })).toEqual({ result: 'not_head', state });
    expect(acknowledge(state, { id: 'absent', now: NOW })).toEqual({ result: 'already_removed', state });
    expect(recordAttemptFailure(state, { id: 'absent', now: NOW })).toEqual({ result: 'missing', state });
    expect(nextDelivery(initialState(), { now: NOW })).toBeNull();
  });
});

describe('가동 확인 복원과 직렬화', () => {
  it('확인된 파일 부재는 경고 없이 초기 상태이고 초기 상태는 저장하지 않는다', () => {
    expect(restored(null)).toEqual({ source: 'missing', state: initialState(), warnings: [] });
    expect(() => serializeState(initialState())).toThrow('invalid_state');
  });

  it.each([
    ['{secret-example', 'corrupt_json'],
    ['{"version":2,"token":"secret-example"}', 'unknown_version'],
    ['null', 'unknown_version'],
    ['[]', 'unknown_version'],
  ])('잘못된 파일 %s는 값을 노출하지 않고 %s로 초기화한다', (raw, code) => {
    const result = restored(raw);
    expect(result).toEqual({ source: 'reset', state: initialState(), warnings: [{ code }] });
    expect(JSON.stringify(result)).not.toContain('secret-example');
  });

  const invalidCases: [string, (state: Record<string, unknown>) => void][] = [
    [
      'unknown',
      (s) => {
        s.secretExample = 'secret-example';
      },
    ],
    [
      'missing',
      (s) => {
        delete s.pending;
      },
    ],
    [
      'failure fraction',
      (s) => {
        s.consecutiveFailures = 1.5;
      },
    ],
    [
      'failure range',
      (s) => {
        s.consecutiveFailures = 3;
      },
    ],
    [
      'failure negative',
      (s) => {
        s.consecutiveFailures = -1;
      },
    ],
    [
      'failure flag',
      (s) => {
        s.alerting = false;
      },
    ],
    [
      'flag type',
      (s) => {
        s.alerting = 'true';
      },
    ],
    [
      'alert missing',
      (s) => {
        s.lastAlertAt = null;
      },
    ],
    [
      'alert date',
      (s) => {
        s.lastAlertAt = '2026-10-24';
      },
    ],
    [
      'recovery date',
      (s) => {
        s.lastRecoveryAt = 'secret-example';
      },
    ],
    [
      'update null',
      (s) => {
        s.updatedAt = null;
      },
    ],
    [
      'update canonical',
      (s) => {
        s.updatedAt = '2026-10-24T00:00:00Z';
      },
    ],
    [
      'run null',
      (s) => {
        s.lastRunId = null;
      },
    ],
    [
      'run zero prefix',
      (s) => {
        s.lastRunId = '02';
      },
    ],
    [
      'run numeric',
      (s) => {
        s.lastRunId = 2;
      },
    ],
    [
      'pending type',
      (s) => {
        s.pending = {};
      },
    ],
    [
      'pending cap',
      (s) => {
        s.pending = Array(5).fill((s.pending as unknown[])[0]);
      },
    ],
    [
      'pending duplicate',
      (s) => {
        (s.pending as unknown[]).push((s.pending as unknown[])[0]);
      },
    ],
    [
      'pending unknown',
      (s) => {
        (s.pending as Record<string, unknown>[])[0]!.extra = 'secret-example';
      },
    ],
    [
      'pending key',
      (s) => {
        (s.pending as PendingNotice[])[0]!.id = 'drill-other:down:2.1';
      },
    ],
    [
      'pending kind',
      (s) => {
        (s.pending as PendingNotice[])[0]!.id = 'prod:recovery:2.1';
      },
    ],
    [
      'pending attempt format',
      (s) => {
        (s.pending as PendingNotice[])[0]!.id = 'prod:down:2.01';
      },
    ],
    [
      'pending run match',
      (s) => {
        (s.pending as PendingNotice[])[0]!.decidedRunId = '1';
      },
    ],
    [
      'pending future run',
      (s) => {
        (s.pending as PendingNotice[])[0]!.id = 'prod:down:3.1';
        (s.pending as PendingNotice[])[0]!.decidedRunId = '3';
      },
    ],
    [
      'pending after update',
      (s) => {
        (s.pending as PendingNotice[])[0]!.decidedAt = iso(1);
      },
    ],
    [
      'attempt negative',
      (s) => {
        (s.pending as PendingNotice[])[0]!.attempts = -1;
      },
    ],
    [
      'attempt fraction',
      (s) => {
        (s.pending as PendingNotice[])[0]!.attempts = 0.1;
      },
    ],
    [
      'attempt zero time',
      (s) => {
        (s.pending as PendingNotice[])[0]!.lastAttemptAt = iso();
      },
    ],
    [
      'attempt missing time',
      (s) => {
        (s.pending as PendingNotice[])[0]!.attempts = 1;
      },
    ],
    [
      'attempt early time',
      (s) => {
        (s.pending as PendingNotice[])[0]!.attempts = 1;
        (s.pending as PendingNotice[])[0]!.lastAttemptAt = iso(-1);
      },
    ],
    [
      'delivered duplicate',
      (s) => {
        s.lastDelivered = { id: 'prod:down:2.1', kind: 'down', at: iso() };
      },
    ],
    [
      'delivered future run',
      (s) => {
        s.lastDelivered = { id: 'prod:down:3.1', kind: 'down', at: iso() };
      },
    ],
    [
      'delivered kind',
      (s) => {
        s.lastDelivered = { id: 'prod:down:1.1', kind: 'recovery', at: iso() };
      },
    ],
    [
      'delivered date',
      (s) => {
        s.lastDelivered = { id: 'prod:down:1.1', kind: 'down', at: 'secret-example' };
      },
    ],
    [
      'delivered unknown',
      (s) => {
        s.lastDelivered = { id: 'prod:down:1.1', kind: 'down', at: iso(), secret: 'secret-example' };
      },
    ],
  ];
  it.each(invalidCases)('schema를 어긴 파일을 복원하지 않는다: %s', (_name, tamper) => {
    const value = JSON.parse(serializeState(downState())) as Record<string, unknown>;
    tamper(value);
    const result = restored(JSON.stringify(value));
    expect(result).toMatchObject({ source: 'reset', state: initialState(), warnings: [{ code: 'invalid_schema' }] });
    expect(JSON.stringify(result)).not.toContain('secret-example');
  });

  it('FIFO 시각이 뒤집힌 파일을 거부한다', () => {
    const state = observe(downState(), input('3', { now: NOW + 2, ok: true })).state;
    state.pending[0]!.decidedAt = iso(1);
    state.pending[1]!.decidedAt = iso();
    expect(restored(JSON.stringify(state), NOW + 2).warnings).toEqual([
      { code: 'invalid_schema', field: 'pending[1].decidedAt' },
    ]);
  });

  it.each([
    [60 * MINUTE, false],
    [60 * MINUTE + 1, true],
  ])('묵음 %sms에서 초기화 여부는 %s다', (elapsed, stale) => {
    const state = downState();
    const result = restored(serializeState(state), NOW + elapsed);
    expect(result.state).toEqual({ ...state, consecutiveFailures: stale ? 0 : 2 });
    expect(result.warnings).toEqual(stale ? [{ code: 'stale_reset' }] : []);
  });

  it('묵음 복원 뒤 같은 실행은 건너뛰고 새로운 실패는 한 번만 센다', () => {
    const state = observe(initialState(), input('20')).state;
    const next = restored(serializeState(state), NOW + 61 * MINUTE).state;
    expect(next).toEqual({ ...state, consecutiveFailures: 0 });
    expect(observe(next, input('20', { now: NOW + 61 * MINUTE }))).toMatchObject({ result: 'skipped', state: next });
    expect(observe(next, input('21', { now: NOW + 61 * MINUTE })).state.consecutiveFailures).toBe(1);
  });

  it('묵음 복원은 전달 기록과 미전송 실패 기록을 보존한다', () => {
    let state = observe(delivered(), input('3', { ok: true })).state;
    state = recordAttemptFailure(state, { id: state.pending[0]!.id, now: NOW }).state;
    const result = restored(serializeState(state), NOW + 61 * MINUTE);
    expect(result.state).toEqual({ ...state, consecutiveFailures: 0 });
  });

  it('필드 삽입 순서와 관계없이 고정한 순서로 직렬화하고 왕복한다', () => {
    const state = observe(downState(), input('3', { ok: true })).state;
    const reversed = Object.fromEntries(Object.entries(state).reverse()) as unknown as UptimeState;
    reversed.pending = state.pending.map(
      (item) => Object.fromEntries(Object.entries(item).reverse()) as unknown as PendingNotice,
    );
    const bytes = serializeState(state);
    expect(bytes.endsWith('\n')).toBe(true);
    expect(serializeState(reversed)).toBe(bytes);
    expect(restored(bytes).state).toEqual(state);
    expect(serializeState(restored(bytes).state)).toBe(bytes);
  });
});

describe('가동 확인 시각과 입력 경계', () => {
  const futureCases: [string, (state: UptimeState) => void][] = [
    [
      'updatedAt',
      (s) => {
        s.updatedAt = iso(1);
      },
    ],
    [
      'lastAlertAt',
      (s) => {
        s.lastAlertAt = iso(1);
      },
    ],
    [
      'lastRecoveryAt',
      (s) => {
        s.lastRecoveryAt = iso(1);
      },
    ],
    [
      'pending.decidedAt',
      (s) => {
        s.pending[0]!.decidedAt = iso(1);
        s.updatedAt = iso(1);
      },
    ],
    [
      'pending.lastAttemptAt',
      (s) => {
        s.pending[0]!.attempts = 1;
        s.pending[0]!.lastAttemptAt = iso(1);
      },
    ],
    [
      'lastDelivered.at',
      (s) => {
        s.lastDelivered = { id: 'prod:down:1.1', kind: 'down', at: iso(1) };
      },
    ],
  ];
  it.each(futureCases)('%s의 시각 역행은 복원·관측·전달 전이를 모두 막는다', (_name, tamper) => {
    const state = downState();
    tamper(state);
    frozen(state);
    expect(restoreState({ key: 'prod', raw: serializeState(state), now: NOW })).toEqual({ error: 'clock_regressed' });
    const id = state.pending[0]!.id;
    expect(observe(state, input('1'))).toMatchObject({
      result: 'clock_regressed',
      state,
      counted: false,
      added: [],
      dropped: [],
    });
    expect(nextDelivery(state, { now: NOW })).toBeNull();
    expect(recordAttemptFailure(state, { id, now: NOW })).toEqual({ result: 'clock_regressed', state });
    expect(acknowledge(state, { id, now: NOW })).toEqual({ result: 'clock_regressed', state });
  });

  it.each(['', 'prod:bad', '/prod', 'prod\\x', 'prod..x'])('위험한 키 %s를 관측과 복원 전에 거부한다', (key) => {
    expect(() => observe(initialState(), input('1', { key }))).toThrow('invalid_key');
    expect(() => restored(null, NOW, key)).toThrow('invalid_key');
  });

  it.each(['0', '01', '-1', '1.5', '1e2', '1\n'])('잘못된 실행 ID 또는 시도 번호 %s를 거부한다', (value) => {
    expect(() => observe(initialState(), input(value))).toThrow('invalid_run');
    expect(() => observe(initialState(), input('1', { runAttempt: value }))).toThrow('invalid_run');
  });

  it.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])('잘못된 시각 %s를 모든 시각 입력에서 거부한다', (now) => {
    const state = downState();
    expect(() => restoreState({ key: 'prod', raw: null, now })).toThrow('invalid_now');
    expect(() => observe(state, input('3', { now }))).toThrow('invalid_now');
    expect(() => nextDelivery(state, { now })).toThrow('invalid_now');
    expect(() => recordAttemptFailure(state, { id: 'x', now })).toThrow('invalid_now');
    expect(() => acknowledge(state, { id: 'x', now })).toThrow('invalid_now');
  });

  it('고정 기준값을 공개한다', () => {
    expect(UPTIME_LIMITS).toEqual({
      failureThreshold: 2,
      probeTimeoutMs: 10_000,
      reminderMs: 30 * MINUTE,
      staleMs: 60 * MINUTE,
      pendingTtlMs: DAY,
      maxPending: 4,
    });
  });
});
