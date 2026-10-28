import { readFile, writeFile } from 'node:fs/promises';
import { gitProcess } from '../monitor/uptimeGitProcess';

// 자기 임시 config만 실제 Git으로 읽고 결과는 boolean으로만 남긴다.
const args = process.argv.slice(3),
  remote = 'https://example.invalid/repository.git';
const configuration = await readFile(process.env.GIT_CONFIG_GLOBAL!, 'utf8');
const expected =
  'AUTHORIZATION: basic ' + Buffer.from('x-access-token:fixture-uptime-private-canary').toString('base64');
const query = async (url: string) =>
  gitProcess(['config', '--get-urlmatch', 'http.extraHeader', url], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 2000,
    graceMs: 500,
  });
const own = await query(remote),
  other = await query('https://example.invalid/other.git');
await writeFile(
  process.argv[2]!,
  JSON.stringify({
    header: own.code === 0 && own.stdout.trim() === expected,
    scoped: other.code === 1 && other.stdout === '',
    noPlaintext: !configuration.includes('fixture-uptime-private-canary'),
    isolated: [
      'UPTIME_GIT_TOKEN',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GIT_SSL_NO_VERIFY',
      'GIT_TRACE',
      'GIT_CONFIG_COUNT',
    ].every((key) => process.env[key] === undefined),
    tls: args.includes('http.sslVerify=true'),
    redirect: args.includes('http.followRedirects=false'),
    noSecretArgs: !args.some((value) => value.includes('canary') || value.includes(expected)),
    interactive: process.env.GIT_TERMINAL_PROMPT === '0' && process.env.GCM_INTERACTIVE === 'never',
    privateConfig:
      process.env.GIT_CONFIG_GLOBAL === process.env.GIT_CONFIG_SYSTEM && process.env.GIT_CONFIG_NOSYSTEM === '1',
  }),
);
process.exitCode = 1;
