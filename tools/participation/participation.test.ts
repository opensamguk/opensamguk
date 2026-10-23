import { spawn } from 'node:child_process';
import { rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseNative, parseResult, parseCompletion } from './schema';
import { syntheticBundle } from './testFixture';
import { digest, validateBundle } from './validate';

const dirs: string[] = [];
async function fixture(mode: 'm2' | 'm3' = 'm2') {
  const f = await syntheticBundle(mode);
  dirs.push(f.dir);
  return f;
}
const runCli = (...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tools/participation/cli.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      stderr += error.message;
    });
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('T2-18/T3-15 evidence tooling, never product acceptance', () => {
  it.each(['m2', 'm3'] as const)('validates the %s synthetic control but refuses a product PASS', async (mode) => {
    const f = await fixture(mode);
    const manifest = await f.save();
    const report = await validateBundle(manifest, f.sourceSHA);
    expect(report.issues).toEqual([]);
    expect(report.toolStatus).toBe('VALID');
    expect(report.productStatus).toBe('NOT_READY');
    expect(report.notReadyReasons).toEqual(['SYNTHETIC_TOOL_TEST_ONLY']);
    expect(report.counts).toEqual({ participants: 5, worlds: mode === 'm2' ? 2 : 1, actions: mode === 'm2' ? 45 : 40 });
    expect(report.acStatus).toBe('NOT_ASSESSED');
  });
  it.each(['m2', 'm3'] as const)('keeps the %s real CLI fixture and ordinary exit contracts', async (mode) => {
    const f = await fixture(mode);
    const manifest = await f.save();
    const [result, ordinary] = await Promise.all([
      runCli('validate', '--manifest', manifest, '--source-sha', f.sourceSHA, '--fixture'),
      runCli('validate', '--manifest', manifest, '--source-sha', f.sourceSHA),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(ordinary.status, ordinary.stderr).toBe(1);
    for (const execution of [result, ordinary]) {
      const report = JSON.parse(execution.stdout);
      expect(report.toolStatus).toBe('VALID');
      expect(report.productStatus).toBe('NOT_READY');
      expect(report.acStatus).toBe('NOT_ASSESSED');
      expect(report.notReadyReasons).toEqual(['SYNTHETIC_TOOL_TEST_ONLY']);
      expect(report.counts).toEqual({
        participants: 5,
        worlds: mode === 'm2' ? 2 : 1,
        actions: mode === 'm2' ? 45 : 40,
      });
      expect(report.notice).toContain('No season PASS');
    }
  });
  const negatives: [string, (f: Awaited<ReturnType<typeof fixture>>) => void, string][] = [
    [
      'one agent with five accounts',
      (f) => {
        for (const p of f.m.participants) p.sessionRef = 'same-session';
      },
      'DUPLICATE_sessionRef',
    ],
    [
      'one login session',
      (f) => {
        for (const p of f.m.participants) p.loginSessionRef = `login-${digest('same-login')}`;
      },
      'DUPLICATE_loginSessionRef',
    ],
    [
      'one account',
      (f) => {
        for (const p of f.m.participants) p.accountRef = `account-${digest('same-account')}`;
      },
      'DUPLICATE_accountRef',
    ],
    [
      'same native run under aliases',
      (f) => {
        for (const [ref, item] of f.records)
          if (item.kind === 'native') f.put(ref, 'native', { ...parseNative(item.value), runRef: 'same-run' });
      },
      'DUPLICATE_NATIVE_RUN',
    ],
    [
      'one world',
      (f) => {
        f.m.worlds.splice(1);
      },
      'WORLD_COUNT',
    ],
    [
      'action SHA mismatch',
      (f) => {
        f.actions[0]!.sourceSHA = 'b'.repeat(40);
      },
      'ACTION_SHA_MISMATCH',
    ],
    [
      'one unfinished season',
      (f) => {
        f.m.outcomes[1]!.completionRef = null;
      },
      'SEASON_NOT_ENDED',
    ],
    [
      'participant leaves before end',
      (f) => {
        f.actions.splice(
          f.actions.findIndex((a) => a.step === 'season_end'),
          1,
        );
      },
      'PARTICIPANT_DID_NOT_REACH_SEASON_END',
    ],
    [
      'rollback',
      (f) => {
        f.m.outcomes[0]!.rollbackCount = 1;
      },
      'ROLLBACK_NONZERO_OR_MISSING',
    ],
    [
      'feedback missing',
      (f) => {
        f.m.feedback.pop();
      },
      'FEEDBACK_MISSING',
    ],
    [
      'P0 remains',
      (f) => {
        f.m.defects.push({
          id: 'bug-1',
          severity: 'P0',
          status: 'open',
          participantId: 'P1',
          worldId: 'world-0',
          sourceSHA: f.sourceSHA,
          trackingRef: null,
          evidenceRef: 'bug-evidence',
        });
        f.put('bug-evidence', 'gate', {
          version: 1,
          id: 'bug-1',
          sourceSHA: f.sourceSHA,
          evidenceSourceRef: 'issue-1',
        });
      },
      'OPEN_P0',
    ],
    [
      'P1 not tracked',
      (f) => {
        f.m.defects.push({
          id: 'bug-1',
          severity: 'P1',
          status: 'open',
          participantId: 'P1',
          worldId: 'world-0',
          sourceSHA: f.sourceSHA,
          trackingRef: null,
          evidenceRef: 'bug-evidence',
        });
        f.put('bug-evidence', 'gate', {
          version: 1,
          id: 'bug-1',
          sourceSHA: f.sourceSHA,
          evidenceSourceRef: 'issue-1',
        });
      },
      'UNTRACKED_P1',
    ],
    [
      'five browsers without native evidence',
      (f) => {
        for (const p of f.m.participants) f.records.delete(p.nativeRef);
      },
      'MISSING_ARTIFACT',
    ],
    [
      'scripted requests without decisions',
      (f) => {
        const n = parseNative(f.records.get('native-0')!.value);
        n.decisions = [];
        f.put('native-0', 'native', n);
      },
      'NATIVE_DECISION_MISSING',
    ],
    [
      'no observation feedback loop',
      (f) => {
        const n = parseNative(f.records.get('native-0')!.value);
        n.decisions[1]!.observationRef = 'not-returned';
        f.put('native-0', 'native', n);
      },
      'NATIVE_OBSERVATION_CHAIN_MISSING',
    ],
    [
      'result bound to another request',
      (f) => {
        const r = parseResult(f.records.get('result-0-0')!.value);
        r.requestRef = 'other-request';
        f.put('result-0-0', 'result', r);
      },
      'RESULT_MISMATCH',
    ],
    [
      'blocked participant',
      (f) => {
        const r = parseResult(f.records.get('result-0-0')!.value);
        r.status = 'blocked';
        f.put('result-0-0', 'result', r);
      },
      'BLOCKED_PARTICIPANT',
    ],
    [
      'admin route',
      (f) => {
        f.actions[0]!.path = '/trpc/admin.advance';
      },
      'NON_PLAYER_ACTION',
    ],
    [
      'ended before frozen condition',
      (f) => {
        const e = parseCompletion(f.records.get('completion-world-0')!.value);
        e.year = 199;
        f.put('completion-world-0', 'completion', e);
      },
      'END_CONDITION_NOT_REACHED',
    ],
    [
      'reversed onboarding',
      (f) => {
        f.actions[0]!.at = f.at(300);
        const result = parseResult(f.records.get('result-0-0')!.value);
        result.at = f.at(301);
        f.put('result-0-0', 'result', result);
      },
      'ONBOARDING_ORDER',
    ],
    [
      'duplicate JSONL',
      (f) => {
        f.actions.push(f.actions[0]!);
      },
      'DUPLICATE_REQUEST',
    ],
    [
      'late registration',
      (f) => {
        f.m.registeredAt = f.at(10);
      },
      'PERIOD_NOT_FROZEN_BEFORE_START',
    ],
  ];
  it.each(negatives)('rejects %s', async (_name, mutate, code) => {
    const f = await fixture();
    mutate(f);
    const manifest = await f.save();
    const report = await validateBundle(manifest, f.sourceSHA);
    expect(report.productStatus).toBe('NOT_READY');
    expect(report.issues).toContain(code);
    expect((await runCli('validate', '--manifest', manifest, '--source-sha', f.sourceSHA, '--fixture')).status).toBe(1);
  });
  it('requires current prerequisites even when all evidence shapes are present', async () => {
    const f = await fixture();
    f.m.prerequisites = [];
    const report = await validateBundle(await f.save(), f.sourceSHA);
    expect(report.notReadyReasons).toContain('PREREQUISITE_T2-09');
    expect(report.notReadyReasons).toContain('PREREQUISITE_cross-review');
    expect(report.productStatus).toBe('NOT_READY');
  });
  it('does not join character creation in one world to turns in another', async () => {
    const f = await fixture();
    const action = f.actions.find((a) => a.participantId === 'P1' && a.step === 'general_create')!;
    action.worldId = 'world-1';
    const result = parseResult(f.records.get(action.resultRef)!.value);
    result.worldId = 'world-1';
    f.put(action.resultRef, 'result', result);
    expect((await validateBundle(await f.save(), f.sourceSHA)).issues).toContain('WORLD_PLAY_SEQUENCE');
  });
  it('does not authenticate native provenance or accept an AC even for a structurally complete actual-labelled bundle', async () => {
    const f = await fixture();
    // Deliberate label spoof: only a reviewer resolving native IDs can authenticate origin.
    f.m.kind = 'actual';
    const report = await validateBundle(await f.save(), f.sourceSHA);
    expect(report.productStatus).toBe('NOT_READY');
    expect(report.evidenceStatus).toBe('COMPLETE_FOR_REVIEW');
    expect(report.notReadyReasons).toContain('NATIVE_RUNTIME_REVIEW_REQUIRED');
    expect(report.acStatus).toBe('NOT_ASSESSED');
    expect(report.nativeProvenance).toBe('REQUIRES_RUNTIME_REVIEW');
  });
  it('detects a changed frozen plan, manifest SHA mismatch, missing source and hash tampering', async () => {
    const f = await fixture();
    const manifest = await f.save();
    f.m.endsAt = f.at(7200);
    expect((await validateBundle(await f.save(false), f.sourceSHA)).issues).toContain('FROZEN_PLAN_CHANGED');
    expect((await validateBundle(manifest, 'b'.repeat(40))).issues).toContain('SOURCE_SHA_MISMATCH');
    expect((await validateBundle(manifest, 'aaa')).productStatus).toBe('NOT_READY');
    await writeFile(join(f.dir, 'actions.jsonl'), '\n');
    expect((await validateBundle(manifest, f.sourceSHA)).issues).toContain('EVENTS_HASH_MISMATCH');
  });
  it.each(['cookie', 'password', 'email', 'token', 'ip', 'unexpected'])(
    'rejects unknown %s fields without echoing raw values',
    async (key) => {
      const f = await fixture();
      const manifest = await f.save();
      await writeFile(manifest, JSON.stringify({ ...f.m, [key]: 'private-value-never-echo' }));
      const result = await runCli('validate', '--manifest', manifest, '--source-sha', f.sourceSHA);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain('private-value-never-echo');
      expect(JSON.parse(result.stdout).productStatus).toBe('NOT_READY');
    },
  );
  it('rejects private text even in an allowed field and scans unused artifacts', async () => {
    const f = await fixture();
    f.put('unused', 'gate', { version: 1, id: 'private@example.test', sourceSHA: f.sourceSHA, evidenceSourceRef: 'x' });
    expect((await validateBundle(await f.save(), f.sourceSHA)).issues).toContain('PRIVATE_DATA');
  });
  it('rejects path traversal and symlink escape', async () => {
    const f = await fixture();
    const unsafeManifest = await f.save();
    f.m.events.file = '../other.jsonl';
    await writeFile(unsafeManifest, JSON.stringify(f.m));
    expect((await validateBundle(unsafeManifest, f.sourceSHA)).productStatus).toBe('NOT_READY');
    f.m.events.file = 'actions.jsonl';
    const manifest = await f.save();
    const other = await fixture();
    await other.save();
    await rm(join(f.dir, 'actions.jsonl'));
    await symlink(join(other.dir, 'actions.jsonl'), join(f.dir, 'actions.jsonl'));
    expect((await validateBundle(manifest, f.sourceSHA)).issues).toContain('UNSAFE_PATH');
  });
  it('rejects unknown versions, malformed JSONL, artifact hashes and absent evidence', async () => {
    const f = await fixture();
    const manifest = await f.save();
    await writeFile(manifest, JSON.stringify({ ...f.m, version: 2 }));
    expect((await validateBundle(manifest, f.sourceSHA)).toolStatus).toBe('INVALID');
    await f.save();
    await writeFile(join(f.dir, 'native-0.json'), '{}');
    expect((await validateBundle(manifest, f.sourceSHA)).issues).toContain('ARTIFACT_HASH_MISMATCH');
    await f.save();
    const broken = '{not json}\n';
    f.m.events.sha256 = digest(broken);
    await writeFile(join(f.dir, 'actions.jsonl'), broken);
    await writeFile(manifest, JSON.stringify(f.m));
    expect((await validateBundle(manifest, f.sourceSHA)).productStatus).toBe('NOT_READY');
    const [missing, invalid, badProbe] = await Promise.all([
      runCli('validate', '--manifest', join(f.dir, 'missing.json'), '--source-sha', f.sourceSHA),
      runCli('invalid'),
      runCli('probe', '--base-url', 'http://not-loopback.invalid', '--source-sha', f.sourceSHA),
    ]);
    expect(missing.status, missing.stderr).toBe(1);
    expect(invalid.status, invalid.stderr).toBe(2);
    expect(badProbe.status, badProbe.stderr).toBe(2);
  });
});
