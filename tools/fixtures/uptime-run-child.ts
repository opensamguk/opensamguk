import { readFile } from 'node:fs/promises';
import { runUptime, UptimeRunError, type UptimeRunConfig } from '../monitor/uptimeRun';
import { probeHealth } from '../monitor/uptimeProbe';
import { sendUptimeNotice } from '../monitor/uptimeWebhook';
import { gitProcess } from '../monitor/uptimeGitProcess';
import { UPTIME_REF } from '../monitor/uptimeGit';
import type { UptimeState } from '../monitor/uptimeState';

const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  config: UptimeRunConfig;
  localRemote: string;
  healthUrl: string;
  receiverUrl: string;
  now: number;
  loseAckReply?: boolean;
  loseObserveReply?: boolean;
  failRead?: boolean;
};
const commands: string[] = [],
  directories: string[] = [],
  pids: number[] = [],
  sent: { id: string; persisted: boolean }[] = [];
let clockCalls = 0,
  operations = 0,
  probes = 0;
try {
  const result = await runUptime(input.config, {
    clock: () => input.now + clockCalls++,
    git: {
      localRemote: input.localRemote,
      process: { timeoutMs: 10000, graceMs: 1000, onSpawn: (pid) => pids.push(pid) },
      onDirectory: (directory) => {
        directories.push(directory);
        operations++;
      },
      onCommand: (name) => {
        commands.push(name);
        if (name === 'fetch' && input.failRead) throw new Error('fixture-private-read-canary');
      },
      afterPush: async (attempt) => {
        if (((input.loseAckReply && operations > 1) || (input.loseObserveReply && operations === 1)) && attempt === 0)
          throw new Error('fixture-private-ack-canary');
      },
    },
    probe: async (options) => {
      probes++;
      return probeHealth({ ...options, baseUrl: new URL(input.healthUrl) });
    },
    send: async (options) => {
      const raw = await gitProcess(
        ['--git-dir', input.localRemote, 'show', `${UPTIME_REF}:uptime/${input.config.key}.json`],
        { cwd: process.cwd(), env: process.env, timeoutMs: 10000, graceMs: 1000 },
      );
      if (raw.code !== 0) throw new Error('fixture read failed');
      const state = JSON.parse(raw.stdout) as UptimeState;
      sent.push({ id: options.notice.id, persisted: state.pending.some((item) => item.id === options.notice.id) });
      return sendUptimeNotice({ ...options, endpoint: new URL(input.receiverUrl) });
    },
  });
  process.stdout.write(
    JSON.stringify({ ok: true, result, commands, directories, pids, sent, clockCalls, operations, probes }) + '\n',
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      kind: error instanceof UptimeRunError ? error.kind : 'unknown',
      warnings: error instanceof UptimeRunError ? error.warnings : [],
      commands,
      directories,
      pids,
      sent,
      clockCalls,
      operations,
      probes,
    }) + '\n',
  );
  process.exitCode = 1;
}
