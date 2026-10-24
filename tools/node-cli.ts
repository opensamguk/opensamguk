import { basename } from 'node:path';

export function nodeCli(entrypoint: string, args: readonly string[]): [command: string, args: string[]] {
  return [process.execPath, [entrypoint, ...args]];
}

export function pnpmCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): [command: string, args: string[]] {
  const entrypoint = env.npm_execpath;
  if (!entrypoint || !/^pnpm\.(?:c|m)?js$/i.test(basename(entrypoint))) {
    throw new Error('pnpm 스크립트에서 JavaScript CLI 경로를 받아야 합니다. pnpm으로 실행하세요.');
  }
  return nodeCli(entrypoint, args);
}
