export type NoticeKind = 'down' | 'recovery';

export interface PendingNotice {
  id: string;
  kind: NoticeKind;
  decidedAt: string;
  decidedRunId: string;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface UptimeState {
  version: 1;
  consecutiveFailures: number;
  alerting: boolean;
  lastAlertAt: string | null;
  lastRecoveryAt: string | null;
  updatedAt: string | null;
  lastRunId: string | null;
  pending: PendingNotice[];
  lastDelivered: { id: string; kind: NoticeKind; at: string } | null;
}

export interface StateWarning {
  code: 'corrupt_json' | 'unknown_version' | 'invalid_schema' | 'stale_reset';
  field?: string;
}

export type RestoreResult =
  { state: UptimeState; source: 'missing' | 'file' | 'reset'; warnings: StateWarning[] } | { error: 'clock_regressed' };

export interface Observation {
  key: string;
  runId: string;
  runAttempt: string;
  now: number;
  ok: boolean;
  webhookConfigured: boolean;
}

export interface ObservationResult {
  result: 'applied' | 'skipped' | 'clock_regressed';
  state: UptimeState;
  counted: boolean;
  added: PendingNotice[];
  suppressed: 'pending_down' | 'no_webhook' | null;
  dropped: { id: string; reason: 'ttl' | 'cap' }[];
}

const MINUTE = 60_000;
const NOTICE_TTL = 24 * 60 * MINUTE;
const REMINDER_INTERVAL = 30 * MINUTE;
const STALE_INTERVAL = 60 * MINUTE;
const MAX_PENDING = 4;
const DECIMAL = /^[1-9][0-9]*$/;

export const UPTIME_LIMITS = {
  failureThreshold: 2,
  probeTimeoutMs: 10_000,
  reminderMs: REMINDER_INTERVAL,
  staleMs: STALE_INTERVAL,
  pendingTtlMs: NOTICE_TTL,
  maxPending: MAX_PENDING,
} as const;

export function initialState(): UptimeState {
  return {
    version: 1,
    consecutiveFailures: 0,
    alerting: false,
    lastAlertAt: null,
    lastRecoveryAt: null,
    updatedAt: null,
    lastRunId: null,
    pending: [],
    lastDelivered: null,
  };
}

function checkKey(key: string): void {
  if (!key || /[:/\\]/.test(key) || key.includes('..')) throw new RangeError('invalid_key');
}

function timestamp(now: number): string {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new RangeError('invalid_now');
  }
  return new Date(now).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.exec(value)?.[0] === value;
}

function noticeId(value: unknown, kind: unknown, key?: string): { key: string; runId: string } | null {
  if (typeof value !== 'string' || (kind !== 'down' && kind !== 'recovery')) return null;
  const parts = value.split(':');
  const idKey = parts[0];
  const run = parts[2]?.split('.');
  if (parts.length !== 3 || !idKey || parts[1] !== kind || run?.length !== 2) return null;
  if (/[/\\]/.test(idKey) || idKey.includes('..') || (key !== undefined && key !== idKey)) return null;
  if (!isDecimal(run[0]) || !isDecimal(run[1])) return null;
  return { key: idKey, runId: run[0] };
}

// 오류에는 고정 필드 경로만 남기고 입력값은 넣지 않는다.
function schemaError(value: unknown, key?: string): string | null {
  if (!isRecord(value)) return 'state';
  if (!exactFields(value, Object.keys(initialState()))) return 'state';
  if (value.version !== 1) return 'version';
  if (!Number.isInteger(value.consecutiveFailures) || ![0, 1, 2].includes(value.consecutiveFailures as number)) {
    return 'consecutiveFailures';
  }
  if (typeof value.alerting !== 'boolean') return 'alerting';
  if (value.consecutiveFailures === 2 && !value.alerting) return 'consecutiveFailures';
  for (const field of ['lastAlertAt', 'lastRecoveryAt']) {
    if (value[field] !== null && !isTime(value[field])) return field;
  }
  if (value.alerting && value.lastAlertAt === null) return 'lastAlertAt';
  if (!isTime(value.updatedAt)) return 'updatedAt';
  if (!isDecimal(value.lastRunId)) return 'lastRunId';
  if (!Array.isArray(value.pending) || value.pending.length > MAX_PENDING) return 'pending';
  const ids = new Set<string>();
  let previousTime = -Infinity;
  let expectedKey = key;
  for (const [index, item] of value.pending.entries()) {
    const field = `pending[${index}]`;
    if (
      !isRecord(item) ||
      !exactFields(item, ['id', 'kind', 'decidedAt', 'decidedRunId', 'attempts', 'lastAttemptAt'])
    ) {
      return field;
    }
    const id = noticeId(item.id, item.kind, expectedKey);
    if (!id || ids.has(item.id as string)) return `${field}.id`;
    expectedKey = id.key;
    ids.add(item.id as string);
    if (
      !isDecimal(item.decidedRunId) ||
      id.runId !== item.decidedRunId ||
      BigInt(item.decidedRunId) > BigInt(value.lastRunId)
    ) {
      return `${field}.decidedRunId`;
    }
    if (
      !isTime(item.decidedAt) ||
      Date.parse(item.decidedAt) > Date.parse(value.updatedAt) ||
      Date.parse(item.decidedAt) < previousTime
    ) {
      return `${field}.decidedAt`;
    }
    previousTime = Date.parse(item.decidedAt);
    if (!Number.isSafeInteger(item.attempts) || (item.attempts as number) < 0) return `${field}.attempts`;
    if (
      item.attempts === 0
        ? item.lastAttemptAt !== null
        : !isTime(item.lastAttemptAt) || Date.parse(item.lastAttemptAt) < Date.parse(item.decidedAt)
    ) {
      return `${field}.lastAttemptAt`;
    }
  }
  if (value.lastDelivered !== null) {
    const item = value.lastDelivered;
    if (!isRecord(item) || !exactFields(item, ['id', 'kind', 'at'])) return 'lastDelivered';
    const id = noticeId(item.id, item.kind, expectedKey);
    if (!id || ids.has(item.id as string) || BigInt(id.runId) > BigInt(value.lastRunId)) return 'lastDelivered.id';
    if (!isTime(item.at)) return 'lastDelivered.at';
  }
  return null;
}

function clockRegressed(state: UptimeState, now: number): boolean {
  const times = [
    state.updatedAt,
    state.lastAlertAt,
    state.lastRecoveryAt,
    state.lastDelivered?.at,
    ...state.pending.flatMap((item) => [item.decidedAt, item.lastAttemptAt]),
  ];
  return times.some((time) => time != null && Date.parse(time) > now);
}

export function restoreState({ key, raw, now }: { key: string; raw: string | null; now: number }): RestoreResult {
  checkKey(key);
  timestamp(now);
  if (raw === null) return { state: initialState(), source: 'missing', warnings: [] };
  const reset = (warning: StateWarning): RestoreResult => ({
    state: initialState(),
    source: 'reset',
    warnings: [warning],
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return reset({ code: 'corrupt_json' });
  }
  if (!isRecord(value) || value.version !== 1) return reset({ code: 'unknown_version' });
  const field = schemaError(value, key);
  if (field !== null) return reset({ code: 'invalid_schema', field });
  const state = value as unknown as UptimeState;
  if (clockRegressed(state, now)) return { error: 'clock_regressed' };
  if (now - Date.parse(state.updatedAt!) > STALE_INTERVAL) {
    return { state: { ...state, consecutiveFailures: 0 }, source: 'file', warnings: [{ code: 'stale_reset' }] };
  }
  return { state, source: 'file', warnings: [] };
}

export function observe(state: UptimeState, input: Observation): ObservationResult {
  const { key, runId, runAttempt, now, ok, webhookConfigured } = input;
  checkKey(key);
  const at = timestamp(now);
  if (!isDecimal(runId) || !isDecimal(runAttempt)) throw new RangeError('invalid_run');
  const unchanged = (result: 'skipped' | 'clock_regressed'): ObservationResult => ({
    result,
    state,
    counted: false,
    added: [],
    suppressed: null,
    dropped: [],
  });
  if (clockRegressed(state, now)) return unchanged('clock_regressed');
  if (state.lastRunId !== null && BigInt(runId) <= BigInt(state.lastRunId)) return unchanged('skipped');
  const next: UptimeState = { ...state, pending: [], updatedAt: at, lastRunId: runId };
  const result: ObservationResult = {
    result: 'applied',
    state: next,
    counted: true,
    added: [],
    suppressed: null,
    dropped: [],
  };
  for (const item of state.pending) {
    if (now - Date.parse(item.decidedAt) > NOTICE_TTL) result.dropped.push({ id: item.id, reason: 'ttl' });
    else next.pending.push(item);
  }
  const add = (kind: NoticeKind): void => {
    if (!webhookConfigured) {
      result.suppressed = 'no_webhook';
      return;
    }
    const item: PendingNotice = {
      id: `${key}:${kind}:${runId}.${runAttempt}`,
      kind,
      decidedAt: at,
      decidedRunId: runId,
      attempts: 0,
      lastAttemptAt: null,
    };
    next.pending.push(item);
    result.added.push(item);
  };
  if (ok) {
    next.consecutiveFailures = 0;
    if (state.alerting) {
      next.alerting = false;
      next.lastRecoveryAt = at;
      add('recovery');
    }
  } else {
    next.consecutiveFailures = Math.min(state.consecutiveFailures + 1, UPTIME_LIMITS.failureThreshold);
    if (next.consecutiveFailures === UPTIME_LIMITS.failureThreshold && !state.alerting) {
      next.alerting = true;
      next.lastAlertAt = at;
      add('down');
    } else if (
      next.consecutiveFailures === UPTIME_LIMITS.failureThreshold &&
      state.alerting &&
      now - Date.parse(state.lastAlertAt!) >= REMINDER_INTERVAL
    ) {
      if (next.pending.at(-1)?.kind === 'down') result.suppressed = 'pending_down';
      else {
        next.lastAlertAt = at;
        add('down');
      }
    }
  }
  while (next.pending.length > MAX_PENDING) result.dropped.push({ id: next.pending.shift()!.id, reason: 'cap' });
  return result;
}

export function nextDelivery(state: UptimeState, { now }: { now: number }): PendingNotice | null {
  timestamp(now);
  if (clockRegressed(state, now)) return null;
  const item = state.pending[0];
  return item && now - Date.parse(item.decidedAt) <= NOTICE_TTL ? item : null;
}

export function recordAttemptFailure(
  state: UptimeState,
  { id, now }: { id: string; now: number },
): {
  result: 'recorded' | 'not_head' | 'missing' | 'clock_regressed';
  state: UptimeState;
} {
  const at = timestamp(now);
  if (clockRegressed(state, now)) return { result: 'clock_regressed', state };
  const head = state.pending[0];
  if (head?.id !== id) return { result: state.pending.some((item) => item.id === id) ? 'not_head' : 'missing', state };
  if (head.attempts === Number.MAX_SAFE_INTEGER) throw new RangeError('attempts_overflow');
  return {
    result: 'recorded',
    state: {
      ...state,
      pending: [{ ...head, attempts: head.attempts + 1, lastAttemptAt: at }, ...state.pending.slice(1)],
    },
  };
}

export function acknowledge(
  state: UptimeState,
  { id, now }: { id: string; now: number },
): {
  result: 'removed' | 'already_removed' | 'not_head' | 'clock_regressed';
  state: UptimeState;
} {
  const at = timestamp(now);
  if (clockRegressed(state, now)) return { result: 'clock_regressed', state };
  const head = state.pending[0];
  if (head?.id !== id)
    return { result: state.pending.some((item) => item.id === id) ? 'not_head' : 'already_removed', state };
  return {
    result: 'removed',
    state: { ...state, pending: state.pending.slice(1), lastDelivered: { id, kind: head.kind, at } },
  };
}

export function serializeState(state: UptimeState): string {
  if (schemaError(state) !== null) throw new RangeError('invalid_state');
  return (
    JSON.stringify({
      version: state.version,
      consecutiveFailures: state.consecutiveFailures,
      alerting: state.alerting,
      lastAlertAt: state.lastAlertAt,
      lastRecoveryAt: state.lastRecoveryAt,
      updatedAt: state.updatedAt,
      lastRunId: state.lastRunId,
      pending: state.pending.map((item) => ({
        id: item.id,
        kind: item.kind,
        decidedAt: item.decidedAt,
        decidedRunId: item.decidedRunId,
        attempts: item.attempts,
        lastAttemptAt: item.lastAttemptAt,
      })),
      lastDelivered:
        state.lastDelivered === null
          ? null
          : { id: state.lastDelivered.id, kind: state.lastDelivered.kind, at: state.lastDelivered.at },
    }) + '\n'
  );
}
