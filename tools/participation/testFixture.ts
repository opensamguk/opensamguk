import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, requiredGates } from './validate';
import { parsePlan, type Manifest, type Action } from './schema';

// Synthetic evidence is deliberately generated only by tests, outside the repository.
export async function syntheticBundle(mode: 'm2' | 'm3' = 'm2') {
  const dir = await mkdtemp(join(tmpdir(), 'participation-tool-test-'));
  const sourceSHA = 'a'.repeat(40);
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  const m: Manifest = {
    version: 1,
    kind: 'synthetic',
    sourceSHA,
    mode,
    registeredAt: at(0),
    startsAt: at(1),
    endsAt: at(3600),
    planRef: 'plan',
    participants: Array.from({ length: 5 }, (_, i) => ({
      participantId: `P${i + 1}`,
      agent: { provider: 'fixture', model: 'synthetic' },
      sessionRef: `session-${i}`,
      loginSessionRef: `login-${digest(String(i))}`,
      accountRef: `account-${digest(String(i))}`,
      nativeRef: `native-${i}`,
    })),
    worlds: Array.from({ length: mode === 'm2' ? 2 : 1 }, (_, i) => ({
      worldId: `world-${i}`,
      scenario: 'fixture',
      turnTermMinutes: 1,
      preset: 'fixture',
      startsAt: at(1),
      endsAt: at(3600),
      endCondition: { type: 'year', year: 200 },
    })),
    events: { file: 'actions.jsonl', sha256: '' },
    artifacts: [],
    prerequisites: [],
    outcomes: [],
    feedback: [],
    defects: [],
  };
  const records = new Map<string, { kind: Manifest['artifacts'][number]['kind']; value: unknown }>();
  const put = (ref: string, kind: Manifest['artifacts'][number]['kind'], value: unknown) =>
    records.set(ref, { kind, value });
  const actions: Action[] = [];
  for (const [index, p] of m.participants.entries()) {
    const worldId = m.worlds[index % m.worlds.length]!.worldId;
    const decisions: { decisionRef: string; at: string; observationRef: string; requestRef: string }[] = [];
    const steps: Action['step'][] =
      mode === 'm2'
        ? [
            'signup',
            'login',
            'lobby',
            'general_create',
            'turn_submit',
            'turn_result',
            'message',
            'cooperation',
            'season_end',
          ]
        : ['signup', 'login', 'email_verify', 'terms', 'lobby', 'general_create', 'turn_submit', 'turn_result'];
    for (const [n, step] of steps.entries()) {
      const requestRef = `request-${index}-${n}`;
      const resultRef = `result-${index}-${n}`;
      const decisionRef = `decision-${index}-${n}`;
      const seconds = step === 'season_end' ? 3597 : 10 + n * 3;
      decisions.push({
        decisionRef,
        at: at(seconds),
        observationRef: n ? `observation-${index}-${n - 1}` : 'initial-screen',
        requestRef,
      });
      actions.push({
        version: 1,
        participantId: p.participantId,
        worldId,
        sourceSHA,
        at: at(seconds + 1),
        transport: 'http',
        path: step === 'signup' ? '/trpc/auth.signup' : '/trpc/world.list',
        step,
        requestRef,
        resultRef,
        decisionRef,
      });
      put(resultRef, 'result', {
        version: 1,
        participantId: p.participantId,
        worldId,
        sourceSHA,
        requestRef,
        at: at(seconds + 2),
        status: 'ok',
        observationRef: `observation-${index}-${n}`,
      });
    }
    put(p.nativeRef, 'native', {
      version: 1,
      runtime: 'hermes',
      runRef: `run-${index}`,
      participantId: p.participantId,
      sessionRef: p.sessionRef,
      provider: p.agent.provider,
      model: p.agent.model,
      sourceSHA,
      startedAt: at(2),
      endedAt: at(3600),
      nativeSourceRef: `runtime-record-${index}`,
      decisions,
    });
    m.feedback.push({ participantId: p.participantId, evidenceRef: `feedback-${index}` });
    put(`feedback-${index}`, 'feedback', {
      version: 1,
      participantId: p.participantId,
      worldId,
      sourceSHA,
      at: at(3599),
      feedbackRef: `review-feedback-${index}`,
      reproductionRef: null,
    });
  }
  for (const w of m.worlds) {
    const completionRef = `completion-${w.worldId}`;
    put(completionRef, 'completion', {
      version: 1,
      worldId: w.worldId,
      sourceSHA,
      at: at(3598),
      status: 'ENDED',
      winner: null,
      year: 200,
      stateHash: digest(w.worldId),
      endCondition: w.endCondition,
      evidenceSourceRef: `end-screen-${w.worldId}`,
    });
    m.outcomes.push({ worldId: w.worldId, rollbackCount: 0, completionRef: mode === 'm2' ? completionRef : null });
  }
  for (const id of [...requiredGates(mode), 'exact-sha-ci', 'cross-review', 'resource-admission']) {
    const evidenceRef = `gate-${id}`;
    m.prerequisites.push({ id, sourceSHA, status: 'ready', evidenceRef });
    put(evidenceRef, 'gate', { version: 1, id, sourceSHA, evidenceSourceRef: `fixture-${id}` });
  }
  async function save(freeze = true) {
    if (freeze)
      put(
        'plan',
        'plan',
        parsePlan(
          Object.fromEntries(
            ['version', 'sourceSHA', 'mode', 'registeredAt', 'startsAt', 'endsAt', 'participants', 'worlds'].map(
              (key) => [key, m[key as keyof Manifest]],
            ),
          ),
        ),
      );
    m.artifacts = await Promise.all(
      [...records].map(async ([ref, item]) => {
        const content = JSON.stringify(item.value);
        const file = `${ref}.json`;
        await writeFile(join(dir, file), content);
        return { ref, file, sha256: digest(content), kind: item.kind };
      }),
    );
    const events = actions.map((a) => JSON.stringify(a)).join('\n') + '\n';
    m.events.sha256 = digest(events);
    await writeFile(join(dir, m.events.file), events);
    const manifest = join(dir, 'manifest.json');
    await writeFile(manifest, JSON.stringify(m));
    return manifest;
  }
  return { dir, sourceSHA, m, actions, records, put, save, at };
}
