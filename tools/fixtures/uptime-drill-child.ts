import { readFile, writeFile } from 'node:fs/promises';
import { runUptimeDrill, UptimeDrillError, type UptimeDrillConfig } from '../monitor/uptimeDrillRun';

// 시험 생성자 전용 입력이다. 공개 CLI는 인자·로컬 Git 경로·명령을 받지 않는다.
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  config: UptimeDrillConfig;
  localRemote: string;
  now: number;
  failCleanup?: boolean;
  hangBeforeRead?: string;
};
const commands: string[] = [],
  directories: string[] = [],
  ports: number[] = [],
  pids: number[] = [];
let closed = false;
// 외부 URL·웹훅은 연습에 연결되지 않는다.
process.env.PUBLIC_URL = 'http://private-url-canary.invalid';
process.env.OPS_DISCORD_WEBHOOK = 'https://private-webhook-canary.invalid';
try {
  const result = await runUptimeDrill(input.config, {
    clock: () => input.now,
    git: {
      localRemote: input.localRemote,
      process: { timeoutMs: 10_000, graceMs: 1000, onSpawn: (pid) => pids.push(pid) },
      onCommand: (name) => {
        commands.push(name);
      },
      onDirectory: (directory) => directories.push(directory),
      beforeRead: async () => {
        if (!input.hangBeforeRead) return;
        await writeFile(input.hangBeforeRead, JSON.stringify({ ports, directories, pids }), { flag: 'wx' });
        process.on('SIGTERM', () => {});
        await new Promise<never>(() => {
          setInterval(() => {}, 1000);
        });
      },
    },
    onListen: (port) => ports.push(port),
    onClosed: () => {
      closed = true;
      if (input.failCleanup) throw new Error('drill-private-cleanup-canary');
    },
  });
  process.stdout.write(JSON.stringify({ ok: true, ...result, commands, directories, ports, pids, closed }) + '\n');
} catch (error) {
  const kinds = (error instanceof AggregateError ? error.errors : [error]).map((value) =>
    value instanceof UptimeDrillError ? value.kind : 'unknown',
  );
  process.stdout.write(JSON.stringify({ ok: false, kinds, commands, directories, ports, pids, closed }) + '\n');
  process.exitCode = 1;
}
