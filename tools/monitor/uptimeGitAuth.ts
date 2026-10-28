import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { UptimeGitError } from './uptimeGitProcess';

export function validateUptimeToken(token: unknown): asserts token is string {
  if (
    process.platform === 'win32' ||
    typeof process.getuid !== 'function' ||
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 4096 ||
    [...token].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)
  )
    throw new UptimeGitError('configuration');
}

/** 토큰 기록 전에 자기 폴더와 배타 생성 파일의 POSIX 권한·소유 UID를 확인한다. */
export async function writeUptimeAuthConfig(directory: string, remote: string, token: string) {
  validateUptimeToken(token);
  let url: URL;
  try {
    url = new URL(remote);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/')
      throw new Error();
  } catch {
    throw new UptimeGitError('configuration');
  }
  let folder: FileHandle | undefined, file: FileHandle | undefined;
  const failures: UptimeGitError[] = [];
  try {
    folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const owner = await folder.stat();
    if (!owner.isDirectory() || (owner.mode & 0o777) !== 0o700 || owner.uid !== process.getuid!()) throw new Error();
    file = await open(
      join(directory, 'gitconfig'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.uid !== process.getuid!() ||
      metadata.nlink !== 1
    )
      throw new Error();
    const header = Buffer.from('x-access-token:' + token, 'utf8').toString('base64');
    const section = JSON.stringify(url.href);
    await file.writeFile(`[http ${section}]\n\textraHeader = AUTHORIZATION: basic ${header}\n`, 'utf8');
  } catch {
    failures.push(new UptimeGitError('configuration'));
  }
  const closed = await Promise.allSettled([file?.close(), folder?.close()]);
  if (closed.some((item) => item.status === 'rejected')) failures.push(new UptimeGitError('cleanup'));
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, '가동 확인 인증 파일 실패.');
}
