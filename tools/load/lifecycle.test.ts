import { describe, expect, it } from 'vitest';
import {
  commandSettled,
  mayDeleteOwnedData,
  type CommandReceipt,
  OwnedCommands,
  driverFailureDiagnostic,
  parseDriverDiagnostic,
  captureDriverDiagnostics,
} from './lifecycle';

const closed: CommandReceipt = {
  label: 'owned',
  pid: 1,
  startedAt: 1,
  closedAt: 2,
  actualClose: true,
  stdoutEnded: true,
  stderrEnded: true,
  exitCode: 0,
  signal: null,
  failed: false,
};
const valid = {
  succeeded: true,
  ownershipMatches: true,
  databaseOidMatches: true,
  databaseConnections: 0,
  commands: [closed],
  pending: 0,
  stickyUnsettled: false,
};
describe('L4 실제 자식 정착과 소유 DB 삭제 경계', () => {
  it('PID 부재나 exit 사건만으로 실제 close/두 EOF를 대신하지 않는다', () => {
    expect(commandSettled(closed)).toBe(true);
    expect(commandSettled({ ...closed, actualClose: false })).toBe(false);
    expect(commandSettled({ ...closed, stdoutEnded: false })).toBe(false);
    expect(commandSettled({ ...closed, stderrEnded: false })).toBe(false);
  });
  it('실패·알 수 없는 OID·연결·늦은 정착은 삭제를 영구 차단한다', () => {
    expect(mayDeleteOwnedData(valid)).toBe(true);
    for (const patch of [
      { succeeded: false },
      { ownershipMatches: false },
      { databaseOidMatches: false },
      { databaseConnections: 1 },
      { databaseConnections: null },
      { pending: 1 },
      { stickyUnsettled: true },
      { commands: [] },
    ])
      expect(mayDeleteOwnedData({ ...valid, ...patch })).toBe(false);
    expect(mayDeleteOwnedData({ ...valid, commands: [{ ...closed, stderrEnded: false }] })).toBe(false);
  });
});

describe('L5 bounded driver diagnostics without raw native output', () => {
  const diagnostic = driverFailureDiagnostic('migrations', new Error('LOAD_SETUP_DEADLINE_EXCEEDED'));
  it('accepts only exact primitive fields and known labels, codes and stages', () => {
    expect(parseDriverDiagnostic(diagnostic)).toEqual(diagnostic);
    for (const patch of [
      { raw: 'private-canary' },
      { stage: '/private-canary' },
      { code: 'private-canary' },
      { nativeLabel: 'migrations-private-canary' },
      { nativeLabel: { raw: 'private-canary' } },
      { exitCode: -1 },
      { exitCode: 256 },
      { exitCode: NaN },
      { exitClass: 'zero' },
      { stdoutEnded: 'true' },
      { version: 2 },
    ])
      expect(parseDriverDiagnostic({ ...diagnostic, ...patch })).toBeUndefined();
    const getter = Object.defineProperty({ ...diagnostic }, 'code', {
      get() {
        throw new Error('private-canary');
      },
    });
    expect(parseDriverDiagnostic(getter)).toBeUndefined();
  });
  it('streams split lines with bounded oversized-line discard and record count', () => {
    const capture = captureDriverDiagnostics(),
      encoded = JSON.stringify(diagnostic) + '\n';
    capture.feed(Buffer.from(encoded.slice(0, 17)));
    expect(capture.records).toHaveLength(0);
    capture.feed(Buffer.from(encoded.slice(17)));
    capture.feed(Buffer.from('private-canary\n{bad-json}\n' + 'x'.repeat(100_000)));
    capture.feed(Buffer.from('\n' + encoded.repeat(20)));
    expect(capture.records).toHaveLength(8);
    expect(capture.records.every((row) => JSON.stringify(row) === JSON.stringify(diagnostic))).toBe(true);
    expect(JSON.stringify(capture.records)).not.toContain('canary');
    const unterminated = captureDriverDiagnostics();
    unterminated.feed(Buffer.from(encoded.trimEnd()));
    expect(unterminated.records).toHaveLength(0);
    const boundary = captureDriverDiagnostics();
    boundary.feed(Buffer.from(encoded.trimEnd().padEnd(2048) + '\n'));
    boundary.feed(Buffer.from(encoded.trimEnd().padEnd(2049) + '\n'));
    expect(boundary.records).toHaveLength(1);
  });
  it('captures a real failing child only under the exact driver label without changing failure or close evidence', async () => {
    const commands = new OwnedCommands(process.cwd());
    const text = JSON.stringify(diagnostic) + '\n';
    const code = `process.stderr.write('private-canary\\n');process.stderr.write(${JSON.stringify(text.slice(0, 20))});process.stderr.write(${JSON.stringify(text.slice(20))});process.exitCode=7;`;
    for (const label of ['actual-load-driver', 'migrations-execute']) {
      let failure: unknown;
      try {
        await commands.run(process.execPath, ['-e', code], {
          label,
          signal: new AbortController().signal,
          timeoutMs: 2000,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Expected original native failure');
      expect(failure.message).toBe('LOAD_NATIVE_COMMAND_FAILED');
      Object.assign(failure, { nativeLabel: 'private-canary', exitCode: 0, stderr: 'private-canary' });
      const receipt = commands.receipts.at(-1)!;
      expect(commandSettled(receipt)).toBe(true);
      expect(receipt.exitCode).toBe(7);
      expect(commands.pending.size).toBe(0);
      expect(commands.stickyUnsettled).toBe(false);
      expect(receipt.driverDiagnostics).toEqual(label === 'actual-load-driver' ? [diagnostic] : undefined);
      expect(JSON.stringify(receipt)).not.toContain('canary');
      const safe = driverFailureDiagnostic('migrations', failure);
      expect(safe).toMatchObject({
        code: 'LOAD_NATIVE_COMMAND_FAILED',
        exitCode: 7,
        exitClass: 'nonzero',
        closeStatus: 'actual-close',
        stdoutEnded: true,
        stderrEnded: true,
        aborted: false,
        nativeLabel: label === 'migrations-execute' ? label : null,
      });
      expect(JSON.stringify(safe)).not.toContain('canary');
    }
  });
});
