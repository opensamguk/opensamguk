// Evidence contains redacted references, never raw requests, cookies or native transcripts.
type Parser<T> = (value: unknown) => T;
type Parsed<P> = P extends Parser<infer T> ? T : never;
function fail(): never {
  throw new Error('INVALID_EVIDENCE');
}
function object<S extends Record<string, Parser<unknown>>>(shape: S): Parser<{ [K in keyof S]: Parsed<S[K]> }> {
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !Object.hasOwn(shape, key))) return fail();
    return Object.fromEntries(Object.entries(shape).map(([key, parse]) => [key, parse(row[key])])) as {
      [K in keyof S]: Parsed<S[K]>;
    };
  };
}
function text(pattern: RegExp, max = 200): Parser<string> {
  return (value) => (typeof value === 'string' && value.length <= max && pattern.test(value) ? value : fail());
}
function choices<const T extends string>(...items: T[]): Parser<T> {
  return (value) => (items.includes(value as T) ? (value as T) : fail());
}
function array<T>(parse: Parser<T>): Parser<T[]> {
  return (value) => (Array.isArray(value) && value.length <= 100_000 ? value.map(parse) : fail());
}
function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value) => (value === null ? null : parse(value));
}
const integer: Parser<number> = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const version: Parser<1> = (value) => (value === 1 ? 1 : fail());
export const sha = text(/^[a-f0-9]{40}$/);
const hash = text(/^[a-f0-9]{64}$/);
const ref = text(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
const participantId = text(/^P0*[1-9][0-9]*$/);
const label = text(/^[a-zA-Z0-9][a-zA-Z0-9_. /-]{0,119}$/);
const timestamp: Parser<string> = (value) => {
  const parsed = text(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)(value);
  return Number.isFinite(Date.parse(parsed)) && new Date(parsed).toISOString() === parsed ? parsed : fail();
};
const endCondition = object({ type: choices('unification', 'year'), year: integer });
const participant = object({
  participantId,
  agent: object({ provider: label, model: label }),
  sessionRef: ref,
  loginSessionRef: text(/^login-[a-f0-9]{64}$/),
  accountRef: text(/^account-[a-f0-9]{64}$/),
  nativeRef: ref,
});
const world = object({
  worldId: ref,
  scenario: label,
  turnTermMinutes: integer,
  preset: label,
  startsAt: timestamp,
  endsAt: timestamp,
  endCondition,
});
const planShape = {
  version,
  sourceSHA: sha,
  mode: choices('m2', 'm3'),
  registeredAt: timestamp,
  startsAt: timestamp,
  endsAt: timestamp,
  participants: array(participant),
  worlds: array(world),
};
export const parsePlan = object(planShape);
export const parseManifest = object({
  ...planShape,
  kind: choices('actual', 'synthetic', 'probe'),
  planRef: ref,
  events: object({ file: text(/^[a-zA-Z0-9_-]+\.jsonl$/), sha256: hash }),
  artifacts: array(
    object({
      ref,
      file: text(/^[a-zA-Z0-9_-]+\.json$/),
      sha256: hash,
      kind: choices('plan', 'native', 'result', 'completion', 'feedback', 'gate'),
    }),
  ),
  prerequisites: array(object({ id: ref, sourceSHA: sha, status: choices('ready', 'not_ready'), evidenceRef: ref })),
  outcomes: array(object({ worldId: ref, completionRef: nullable(ref), rollbackCount: integer })),
  feedback: array(object({ participantId, evidenceRef: ref })),
  defects: array(
    object({
      id: ref,
      severity: choices('P0', 'P1', 'P2'),
      status: choices('open', 'fixed'),
      participantId,
      worldId: ref,
      sourceSHA: sha,
      trackingRef: nullable(text(/^(AC-[A-Z0-9-]+|backlog-[a-zA-Z0-9_-]+)$/)),
      evidenceRef: ref,
    }),
  ),
});
export type Manifest = Parsed<typeof parseManifest>;
export const parseEvent = object({
  version,
  participantId,
  worldId: ref,
  sourceSHA: sha,
  at: timestamp,
  transport: choices('http', 'screen'),
  path: text(/^(\/trpc\/[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*|\/[a-zA-Z0-9/_-]*)$/),
  step: choices(
    'signup',
    'login',
    'email_verify',
    'terms',
    'lobby',
    'general_create',
    'turn_submit',
    'turn_result',
    'message',
    'cooperation',
    'season_end',
  ),
  requestRef: ref,
  resultRef: ref,
  decisionRef: ref,
});
export type Action = Parsed<typeof parseEvent>;
export const parseNative = object({
  version,
  runtime: choices('hermes', 'codex', 'claude-code'),
  runRef: ref,
  participantId,
  sessionRef: ref,
  provider: label,
  model: label,
  sourceSHA: sha,
  startedAt: timestamp,
  endedAt: timestamp,
  // A reviewer must resolve this opaque ID in the native runtime; JSON alone cannot authenticate it.
  nativeSourceRef: ref,
  decisions: array(object({ decisionRef: ref, at: timestamp, observationRef: ref, requestRef: ref })),
});
export const parseResult = object({
  version,
  participantId,
  worldId: ref,
  sourceSHA: sha,
  requestRef: ref,
  at: timestamp,
  status: choices('ok', 'blocked'),
  observationRef: ref,
});
export const parseCompletion = object({
  version,
  sourceSHA: sha,
  worldId: ref,
  at: timestamp,
  status: choices('ENDED'),
  winner: nullable(ref),
  year: integer,
  stateHash: hash,
  endCondition,
  evidenceSourceRef: ref,
});
export const parseFeedback = object({
  version,
  participantId,
  worldId: ref,
  sourceSHA: sha,
  at: timestamp,
  // Redacted prose is kept in the review system, not copied into this bundle.
  feedbackRef: ref,
  reproductionRef: nullable(ref),
});
export const parseGate = object({ version, id: ref, sourceSHA: sha, evidenceSourceRef: ref });
