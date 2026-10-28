import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2],
  record = process.argv[3];
if (!['--hang-tree', '--hang-orphan', '--hang-leaf'].includes(mode) || !record) process.exit(2);
const event = (kind) => appendFileSync(record, JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + '\n');
event(mode);
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
if (mode === '--hang-leaf') {
  // 부모가 떠나도 손자는 상속한 stdout/stderr와 interval을 유지한다.
  process.on('disconnect', () => {});
  event('--leaf-ready');
  if (!process.send) process.exit(2);
  process.send('ready', (error) => {
    if (error) process.exit(2);
  });
} else {
  let ready = false;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hang-leaf', record], {
    cwd: dirname(record),
    stdio:
      mode === '--hang-orphan'
        ? ['ignore', process.stdout, process.stderr, 'ipc']
        : ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: mode === '--hang-orphan',
    windowsHide: true,
  });
  const fail = () => {
    if (!ready) process.exit(2);
  };
  child.once('error', fail);
  child.once('exit', fail);
  child.once('disconnect', fail);
  child.once('message', (message) => {
    if (message !== 'ready') process.exit(2);
    ready = true;
    event('--parent-ready');
    if (mode === '--hang-orphan') {
      // 고정 sleep 대신 실제 손자의 준비 응답 뒤 정상 exit한다.
      process.once('exit', () => event('--parent-exit'));
      child.unref();
      process.exit(0);
    }
  });
}
