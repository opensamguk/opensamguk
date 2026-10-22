import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  parseManifest,
  parsePlan,
  parseEvent,
  parseNative,
  parseResult,
  parseCompletion,
  parseFeedback,
  parseGate,
  sha,
  type Manifest,
  type Action,
} from './schema';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 8 * 1024 * 1024;
const privateText =
  /(?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:cookie|set-cookie|authorization|password|bearer|sid)\s*[:=]|\beyJ[a-zA-Z0-9_-]+\.)/i;
export const requiredGates = (mode: 'm2' | 'm3') =>
  mode === 'm2'
    ? [
        'M1',
        ...Array.from({ length: 23 }, (_, i) => `T2-${String(i + 1).padStart(2, '0')}`).filter((id) => id !== 'T2-18'),
      ]
    : ['M2', ...Array.from({ length: 14 }, (_, i) => `T3-${String(i + 1).padStart(2, '0')}`), 'release-build'];

export type Report = {
  version: 1;
  toolStatus: 'VALID' | 'INVALID';
  productStatus: 'NOT_READY';
  evidenceStatus: 'COMPLETE_FOR_REVIEW' | 'INCOMPLETE';
  acStatus: 'NOT_ASSESSED';
  nativeProvenance: 'REQUIRES_RUNTIME_REVIEW';
  issues: string[];
  notReadyReasons: string[];
  counts: { participants: number; worlds: number; actions: number };
  manifestSHA256: string | null;
  notice: string;
};
export async function validateBundle(manifestFile: string, expectedSHA: string): Promise<Report> {
  const issues: string[] = [];
  const notReadyReasons: string[] = [];
  const counts = { participants: 0, worlds: 0, actions: 0 };
  let manifestSHA256: string | null = null;
  const check = (condition: unknown, code: string) => {
    if (!condition) issues.push(code);
  };
  try {
    sha(expectedSHA);
    const root = await realpath(dirname(manifestFile));
    async function readLocal(file: string) {
      const resolved = await realpath(join(root, file));
      const rel = relative(root, resolved);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('UNSAFE_PATH');
      const info = await stat(resolved);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error('INVALID_FILE');
      const content = await readFile(resolved, 'utf8');
      if (privateText.test(content)) throw new Error('PRIVATE_DATA');
      return content;
    }
    const manifestText = await readLocal(basename(manifestFile));
    manifestSHA256 = digest(manifestText);
    const m = parseManifest(JSON.parse(manifestText));
    counts.participants = m.participants.length;
    counts.worlds = m.worlds.length;
    check(m.sourceSHA === expectedSHA, 'SOURCE_SHA_MISMATCH');
    if (m.kind !== 'actual')
      notReadyReasons.push(m.kind === 'synthetic' ? 'SYNTHETIC_TOOL_TEST_ONLY' : 'HTTP_PROBE_IS_NOT_PARTICIPATION');
    else notReadyReasons.push('NATIVE_RUNTIME_REVIEW_REQUIRED');
    check(m.participants.length >= 5, 'FIVE_PARTICIPANTS_REQUIRED');
    check(m.worlds.length >= (m.mode === 'm2' ? 2 : 1), 'WORLD_COUNT');
    const unique = (values: string[], code: string) => check(new Set(values).size === values.length, code);
    unique(
      m.participants.map((p) => p.participantId.replace(/^P0*/, 'P')),
      'DUPLICATE_PARTICIPANT',
    );
    for (const key of ['sessionRef', 'loginSessionRef', 'accountRef', 'nativeRef'] as const)
      unique(
        m.participants.map((p) => p[key]),
        `DUPLICATE_${key}`,
      );
    unique(
      m.worlds.map((w) => w.worldId),
      'DUPLICATE_WORLD',
    );
    unique(
      m.artifacts.map((a) => a.ref),
      'DUPLICATE_ARTIFACT',
    );
    unique(
      m.artifacts.map((a) => a.file),
      'DUPLICATE_ARTIFACT_FILE',
    );
    const participants = new Map(m.participants.map((p) => [p.participantId, p]));
    const worlds = new Map(m.worlds.map((w) => [w.worldId, w]));
    check(m.registeredAt < m.startsAt && m.startsAt < m.endsAt, 'PERIOD_NOT_FROZEN_BEFORE_START');
    for (const w of m.worlds) {
      check(
        w.turnTermMinutes > 0 && w.startsAt >= m.startsAt && w.endsAt <= m.endsAt && w.startsAt < w.endsAt,
        'WORLD_PERIOD',
      );
    }
    const data = new Map<string, { kind: Manifest['artifacts'][number]['kind']; value: unknown }>();
    for (const artifact of m.artifacts) {
      const content = await readLocal(artifact.file);
      check(digest(content) === artifact.sha256, 'ARTIFACT_HASH_MISMATCH');
      data.set(artifact.ref, { kind: artifact.kind, value: JSON.parse(content) });
    }
    function artifact<T>(ref: string, kind: Manifest['artifacts'][number]['kind'], parse: (value: unknown) => T): T {
      const item = data.get(ref);
      if (!item || item.kind !== kind) throw new Error('MISSING_ARTIFACT');
      return parse(item.value);
    }
    // Parse every artifact, including unused ones. Unknown fields must not become a secret side channel.
    const parsers = {
      plan: parsePlan,
      native: parseNative,
      result: parseResult,
      completion: parseCompletion,
      feedback: parseFeedback,
      gate: parseGate,
    };
    for (const item of data.values()) parsers[item.kind](item.value);
    const plan = artifact(m.planRef, 'plan', parsePlan);
    const frozen = parsePlan(Object.fromEntries(Object.keys(plan).map((key) => [key, m[key as keyof Manifest]])));
    check(isDeepStrictEqual(plan, frozen), 'FROZEN_PLAN_CHANGED');
    const eventsText = await readLocal(m.events.file);
    check(digest(eventsText) === m.events.sha256, 'EVENTS_HASH_MISMATCH');
    const lines = eventsText.trim() ? eventsText.trimEnd().split('\n') : [];
    if (lines.length > 100_000) throw new Error('TOO_MANY_EVENTS');
    const actions: Action[] = lines.map((line) => parseEvent(JSON.parse(line)));
    counts.actions = actions.length;
    unique(
      actions.map((a) => a.requestRef),
      'DUPLICATE_REQUEST',
    );
    unique(
      actions.map((a) => a.resultRef),
      'DUPLICATE_RESULT',
    );
    unique(
      actions.map((a) => a.decisionRef),
      'DUPLICATE_DECISION',
    );
    const natives = m.participants.map((p) => artifact(p.nativeRef, 'native', parseNative));
    unique(
      natives.map((n) => n.runRef),
      'DUPLICATE_NATIVE_RUN',
    );
    unique(
      natives.map((n) => n.nativeSourceRef),
      'DUPLICATE_NATIVE_SOURCE',
    );
    for (const [index, p] of m.participants.entries()) {
      const native = natives[index]!;
      check(
        native.participantId === p.participantId &&
          native.sessionRef === p.sessionRef &&
          native.provider === p.agent.provider &&
          native.model === p.agent.model &&
          native.sourceSHA === m.sourceSHA,
        'NATIVE_IDENTITY_MISMATCH',
      );
      check(
        native.startedAt <= native.endedAt && native.startedAt <= m.endsAt && native.endedAt >= m.startsAt,
        'NATIVE_PERIOD',
      );
      const own = actions.filter((a) => a.participantId === p.participantId);
      const required = [
        'signup',
        'login',
        'lobby',
        'general_create',
        'turn_submit',
        'turn_result',
        ...(m.mode === 'm3' ? ['email_verify', 'terms'] : ['message', 'cooperation', 'season_end']),
      ];
      for (const step of required)
        check(
          own.some((a) => a.step === step),
          `MISSING_${p.participantId}_${step}`,
        );
      unique(
        native.decisions.map((d) => d.decisionRef),
        'DUPLICATE_NATIVE_DECISION',
      );
      for (const a of own) {
        const d = native.decisions.find((d) => d.decisionRef === a.decisionRef);
        check(
          d && d.requestRef === a.requestRef && d.at <= a.at && d.at >= native.startedAt && a.at <= native.endedAt,
          'NATIVE_DECISION_MISSING',
        );
      }
      // Each decision after the first must cite an observation actually returned to this participant.
      const decisions = [...native.decisions].sort((a, b) => a.at.localeCompare(b.at));
      for (const d of decisions.slice(1)) {
        check(
          own.some((a) => {
            const result = artifact(a.resultRef, 'result', parseResult);
            return result.observationRef === d.observationRef && result.at <= d.at;
          }),
          'NATIVE_OBSERVATION_CHAIN_MISSING',
        );
      }
      // Preserve the signup-to-first-result order, not just a bag of step labels.
      const ordered =
        m.mode === 'm3'
          ? ['signup', 'email_verify', 'terms', 'lobby', 'general_create', 'turn_submit', 'turn_result']
          : ['signup', 'login', 'lobby', 'general_create', 'turn_submit', 'turn_result'];
      let last = m.startsAt;
      for (const step of ordered) {
        const a = own.filter((a) => a.step === step && a.at >= last).sort((a, b) => a.at.localeCompare(b.at))[0];
        check(a, 'ONBOARDING_ORDER');
        if (a) last = artifact(a.resultRef, 'result', parseResult).at;
      }
    }
    for (const a of actions) {
      const w = worlds.get(a.worldId);
      check(participants.has(a.participantId) && w, 'UNKNOWN_PARTICIPANT_OR_WORLD');
      check(a.sourceSHA === m.sourceSHA, 'ACTION_SHA_MISMATCH');
      check(w && a.at >= w.startsAt && a.at <= w.endsAt, 'ACTION_OUTSIDE_PERIOD');
      check(!/(?:admin|internal|engine|database)/i.test(a.path), 'NON_PLAYER_ACTION');
      const result = artifact(a.resultRef, 'result', parseResult);
      check(
        result.participantId === a.participantId &&
          result.worldId === a.worldId &&
          result.sourceSHA === m.sourceSHA &&
          result.requestRef === a.requestRef &&
          result.at >= a.at &&
          result.at <= m.endsAt,
        'RESULT_MISMATCH',
      );
      check(result.status === 'ok', 'BLOCKED_PARTICIPANT');
    }
    unique(
      m.outcomes.map((o) => o.worldId),
      'DUPLICATE_OUTCOME',
    );
    check(m.outcomes.length === m.worlds.length, 'OUTCOME_COUNT');
    for (const w of m.worlds) {
      check(
        actions.some((a) => a.worldId === w.worldId),
        'EMPTY_WORLD',
      );
      const outcome = m.outcomes.find((o) => o.worldId === w.worldId);
      check(outcome?.rollbackCount === 0, 'ROLLBACK_NONZERO_OR_MISSING');
      if (m.mode === 'm2') {
        check(outcome?.completionRef, 'SEASON_NOT_ENDED');
        if (outcome?.completionRef) {
          const end = artifact(outcome.completionRef, 'completion', parseCompletion);
          check(
            end.worldId === w.worldId &&
              end.sourceSHA === m.sourceSHA &&
              end.at >= w.startsAt &&
              end.at <= w.endsAt &&
              isDeepStrictEqual(end.endCondition, w.endCondition),
            'COMPLETION_MISMATCH',
          );
          check(
            w.endCondition.type === 'year' ? end.year >= w.endCondition.year : end.winner !== null,
            'END_CONDITION_NOT_REACHED',
          );
          for (const p of m.participants.filter((p) =>
            actions.some((a) => a.participantId === p.participantId && a.worldId === w.worldId),
          )) {
            check(
              actions.some(
                (a) =>
                  a.participantId === p.participantId &&
                  a.worldId === w.worldId &&
                  a.step === 'season_end' &&
                  a.at >= end.at,
              ),
              'PARTICIPANT_DID_NOT_REACH_SEASON_END',
            );
          }
        }
      }
    }
    unique(
      m.feedback.map((f) => f.participantId),
      'DUPLICATE_FEEDBACK',
    );
    check(m.feedback.length === m.participants.length, 'FEEDBACK_COUNT');
    for (const p of m.participants) {
      const feedback = m.feedback.find((f) => f.participantId === p.participantId);
      check(feedback, 'FEEDBACK_MISSING');
      if (feedback) {
        const f = artifact(feedback.evidenceRef, 'feedback', parseFeedback);
        check(
          f.participantId === p.participantId &&
            worlds.has(f.worldId) &&
            f.sourceSHA === m.sourceSHA &&
            f.at >= m.startsAt &&
            f.at <= m.endsAt,
          'FEEDBACK_MISMATCH',
        );
      }
    }
    unique(
      m.defects.map((d) => d.id),
      'DUPLICATE_DEFECT',
    );
    for (const defect of m.defects) {
      check(
        participants.has(defect.participantId) && worlds.has(defect.worldId) && defect.sourceSHA === m.sourceSHA,
        'DEFECT_IDENTITY',
      );
      check(defect.severity !== 'P0' || defect.status === 'fixed', 'OPEN_P0');
      check(defect.severity !== 'P1' || defect.trackingRef !== null, 'UNTRACKED_P1');
      const evidence = artifact(defect.evidenceRef, 'gate', parseGate);
      check(evidence.id === defect.id && evidence.sourceSHA === m.sourceSHA, 'DEFECT_EVIDENCE_MISMATCH');
    }
    unique(
      m.prerequisites.map((g) => g.id),
      'DUPLICATE_GATE',
    );
    for (const id of [...requiredGates(m.mode), 'exact-sha-ci', 'cross-review', 'resource-admission']) {
      const gate = m.prerequisites.find((g) => g.id === id);
      if (!gate || gate.status !== 'ready' || gate.sourceSHA !== m.sourceSHA)
        notReadyReasons.push(`PREREQUISITE_${id}`);
      if (gate) {
        const evidence = artifact(gate.evidenceRef, 'gate', parseGate);
        check(evidence.id === id && evidence.sourceSHA === m.sourceSHA, 'GATE_EVIDENCE_MISMATCH');
      }
    }
  } catch (error) {
    // Never echo input paths, JSON lines, native text or exception messages.
    const code =
      error instanceof Error &&
      ['UNSAFE_PATH', 'PRIVATE_DATA', 'INVALID_FILE', 'TOO_MANY_EVENTS', 'MISSING_ARTIFACT'].includes(error.message)
        ? error.message
        : 'INVALID_OR_MISSING_EVIDENCE';
    issues.push(code);
  }
  if (issues.length) notReadyReasons.push('EVIDENCE_INCOMPLETE_OR_INVALID');
  return {
    version: 1,
    toolStatus: issues.length ? 'INVALID' : 'VALID',
    productStatus: 'NOT_READY',
    evidenceStatus:
      issues.length || notReadyReasons.some((reason) => reason.startsWith('PREREQUISITE_'))
        ? 'INCOMPLETE'
        : 'COMPLETE_FOR_REVIEW',
    acStatus: 'NOT_ASSESSED',
    nativeProvenance: 'REQUIRES_RUNTIME_REVIEW',
    issues: [...new Set(issues)],
    notReadyReasons: [...new Set(notReadyReasons)],
    counts,
    manifestSHA256,
    notice:
      'Synthetic fixtures and HTTP probes validate tooling only. No season PASS, AC acceptance, public rehearsal or launch is certified. An independent reviewer must resolve nativeSourceRef and all evidenceSourceRef IDs in their original systems.',
  };
}
