import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { updateUptimeGit, type UptimeGitInput } from '../monitor/uptimeGit';
import { UptimeGitError } from '../monitor/uptimeGitProcess';

const mode = process.argv[2];
if (mode === '--environment') {
  await writeFile(
    process.argv[3]!,
    JSON.stringify({
      sslNoVerify: process.env.GIT_SSL_NO_VERIFY ?? null,
      allowProtocol: process.env.GIT_ALLOW_PROTOCOL ?? null,
      configCount: process.env.GIT_CONFIG_COUNT ?? null,
      trace: process.env.GIT_TRACE ?? null,
      noSystem: process.env.GIT_CONFIG_NOSYSTEM,
      globalConfig: await readFile(process.env.GIT_CONFIG_GLOBAL!, 'utf8'),
      terminalPrompt: process.env.GIT_TERMINAL_PROMPT,
      interactive: process.env.GCM_INTERACTIVE,
    }),
  );
  process.exitCode = 1;
} else {
  const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
    input: UptimeGitInput;
    localRemote: string;
    barrier?: string;
    failFetch?: boolean;
    losePushReply?: boolean;
    inheritanceCanary?: boolean;
    process?: { timeoutMs: number; graceMs: number; command?: { file: string; prefix: string[] } };
  };
  const commands: string[] = [],
    directories: string[] = [],
    pids: number[] = [];
  if (config.inheritanceCanary) {
    process.env.GIT_SSL_NO_VERIFY = '1';
    process.env.GIT_ALLOW_PROTOCOL = 'ext';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = '/fixture-must-not-inherit';
    process.env.GIT_TRACE = '1';
  }
  try {
    const result = await updateUptimeGit(config.input, {
      localRemote: config.localRemote,
      process: { timeoutMs: 10_000, graceMs: 1000, ...config.process, onSpawn: (pid) => pids.push(pid) },
      onCommand: (name) => {
        commands.push(name);
        if (name === 'fetch' && config.failFetch) throw new Error('fixture-private-error-canary');
      },
      onDirectory: (directory) => directories.push(directory),
      beforePush: async (attempt) => {
        if (!config.barrier || attempt !== 0) return;
        await writeFile(join(config.barrier, config.input.key), 'ready', { flag: 'wx' });
        for (let index = 0; index < 200; index++) {
          const both = await Promise.all(
            ['prod', 'drill-race'].map((key) =>
              stat(join(config.barrier!, key)).then(
                () => true,
                () => false,
              ),
            ),
          );
          if (both.every(Boolean)) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('barrier not reached');
      },
      afterPush: async (attempt) => {
        if (config.losePushReply && attempt === 0) throw new Error('fixture-private-error-canary');
      },
    });
    process.stdout.write(JSON.stringify({ ok: true, ...result, commands, directories, pids }) + '\n');
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    process.stdout.write(
      JSON.stringify({
        ok: false,
        kinds: errors.map((value) => (value instanceof UptimeGitError ? value.kind : 'unknown')),
        commands,
        directories,
        pids,
      }) + '\n',
    );
    process.exitCode = 1;
  }
}
