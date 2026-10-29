import { describe, expect, it } from 'vitest';
import { commandSettled, mayDeleteOwnedData, type CommandReceipt } from './lifecycle';

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
