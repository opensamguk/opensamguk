import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { resolveLoginAudit, type LoginAuditOptions } from '../auth/loginAudit';

/** 기존 환경 설정이 없을 때만 운영 파일을 읽어 bootstrap에 넘긴다. */
export function loadLoginAuditOptions(env: NodeJS.ProcessEnv): LoginAuditOptions | undefined {
  if (
    env.AUDIT_HASH_KEY !== undefined ||
    env.AUDIT_HASH_KEY_VERSION !== undefined ||
    env.AUDIT_HASH_CONFIG_FILE === undefined
  )
    return undefined;
  let descriptor: number | undefined;
  try {
    const file = env.AUDIT_HASH_CONFIG_FILE;
    if (!file || !isAbsolute(file) || typeof process.getuid !== 'function' || !constants.O_NOFOLLOW) throw new Error();
    const uid = process.getuid();
    const directory = lstatSync(dirname(file));
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o777) !== 0o700 ||
      directory.uid !== uid
    )
      throw new Error();
    // FIFO도 열기에서 멈추지 않고 같은 fd의 유형 검사로 거부한다.
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== uid || stat.size < 1 || stat.size > 4096)
      throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(descriptor));
    if (['\0', '\r', '\n'].some((character) => text.includes(character))) throw new Error();
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'key') ||
      !Object.hasOwn(value, 'version')
    )
      throw new Error();
    const options = value as LoginAuditOptions;
    resolveLoginAudit({}, true, options);
    return { key: options.key, version: options.version };
  } catch {
    throw new Error('로그인 조사 키 설정을 확인하세요.');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
