import { basename } from 'node:path';

export function nodeCli(entrypoint: string, args: readonly string[]): [command: string, args: string[]] {
  return [process.execPath, [entrypoint, ...args]];
}

export function pnpmCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): [command: string, args: string[]] {
  // Windows의 환경 사본은 키를 대문자로 바꿀 수 있다. JS 경로 검사와 shell 없는 실행은 유지한다.
  const entrypoint = env.npm_execpath ?? env.NPM_EXECPATH;
  if (!entrypoint || !/^pnpm\.(?:c|m)?js$/i.test(basename(entrypoint))) {
    throw new Error('pnpm 스크립트에서 JavaScript CLI 경로를 받아야 합니다. pnpm으로 실행하세요.');
  }
  return nodeCli(entrypoint, args);
}
