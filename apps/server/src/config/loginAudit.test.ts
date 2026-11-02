import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadLoginAuditOptions } from './loginAudit';

const failure = '로그인 조사 키 설정을 확인하세요.';
const posix = typeof process.getuid === 'function' && Boolean(constants.O_NOFOLLOW);
const key = randomBytes(32).toString('hex');
const payload = JSON.stringify({ key, version: 7 });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let directory: string, file: string, alias: string | undefined;
const env = () => ({ AUDIT_HASH_CONFIG_FILE: file });
function rejected(value: NodeJS.ProcessEnv = env()) {
  let error: unknown;
  try {
    loadLoginAuditOptions(value);
  } catch (caught) {
    error = caught;
  }
  expect(error instanceof Error).toBe(true);
  expect((error as Error).message).toBe(failure);
  expect((error as Error).cause).toBeUndefined();
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'opensamguk-audit-'));
  chmodSync(directory, 0o700);
  file = join(directory, 'private-path-canary');
  writeFileSync(file, payload, { mode: 0o600 });
});
afterEach(() => {
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  expect(basename(directory).startsWith('opensamguk-audit-')).toBe(true);
  chmodSync(directory, 0o700);
  if (alias !== undefined) {
    expect(alias).toBe(directory + '-link');
    rmSync(alias);
    alias = undefined;
  }
  if (posix) chmodSync(file, 0o600);
  rmSync(directory, { recursive: true, force: true });
});

it('T2-15 AC-M2-08 미설정과 기존 환경 주입은 파일을 읽지 않는다', () => {
  expect(loadLoginAuditOptions({}) === undefined).toBe(true);
  for (const supplied of [{ AUDIT_HASH_KEY: key }, { AUDIT_HASH_KEY_VERSION: '7' }, { AUDIT_HASH_KEY: '' }])
    expect(loadLoginAuditOptions({ ...supplied, AUDIT_HASH_CONFIG_FILE: 'relative-missing' }) === undefined).toBe(true);
});

it('T2-15 AC-M2-08 POSIX의 실제 0700·0600 파일만 읽고 미지원 플랫폼은 거부한다', () => {
  if (!posix) return rejected();
  const options = loadLoginAuditOptions(env())!;
  expect(digest(options.key)).toBe(digest(key));
  expect(options.version).toBe(7);
  const multibyte = 'é'.repeat(16);
  writeFileSync(file, JSON.stringify({ key: multibyte, version: 2_147_483_647 }));
  expect(digest(loadLoginAuditOptions(env())!.key)).toBe(digest(multibyte));
  const maximumKey = 'x'.repeat(4096 - Buffer.byteLength(JSON.stringify({ key: '', version: 7 })));
  writeFileSync(file, JSON.stringify({ key: maximumKey, version: 7 }));
  expect(digest(loadLoginAuditOptions(env())!.key)).toBe(digest(maximumKey));
});

it.each(['', 'relative-canary', join(tmpdir(), 'missing-audit-canary', 'file')])(
  'T2-15 AC-M2-08 빈 값·상대·없는 경로를 고정 오류로 거부한다 (%s)',
  (path) => rejected({ AUDIT_HASH_CONFIG_FILE: path }),
);

const invalid = [
  Buffer.alloc(0),
  Buffer.alloc(4097, 0x20),
  Buffer.from([0xff]),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload)]),
  payload + '\0',
  payload + '\r',
  payload + '\n',
  '{',
  'null',
  '[]',
  '"scalar"',
  JSON.stringify({ key, version: 7, extra: true }),
  JSON.stringify({ key }),
  JSON.stringify({ version: 7 }),
  JSON.stringify({ key: 'a'.repeat(31), version: 1 }),
  ...[0, 1.5, '1', 2_147_483_648].map((version) => JSON.stringify({ key, version })),
];
it.each(invalid.map((bytes, index) => ({ bytes, index })))(
  'T2-15 AC-M2-08 크기·인코딩·구조·키·버전 거부 사례 $index',
  ({ bytes }) => {
    writeFileSync(file, bytes);
    rejected();
  },
);

it.each([
  ['directory', 0o755],
  ['file', 0o644],
  ['file', 0o400],
] as const)('T2-15 AC-M2-08 잘못된 %s 권한 %i를 거부한다', (target, mode) => {
  if (posix) chmodSync(target === 'directory' ? directory : file, mode);
  rejected();
});

it('T2-15 AC-M2-08 파일·상위 디렉터리 심볼릭 링크를 거부한다', () => {
  if (!posix) return rejected();
  const target = join(directory, 'target');
  writeFileSync(target, payload, { mode: 0o600 });
  unlinkSync(file);
  symlinkSync(target, file);
  rejected();
  unlinkSync(file);
  writeFileSync(file, payload, { mode: 0o600 });
  alias = directory + '-link';
  symlinkSync(directory, alias);
  rejected({ AUDIT_HASH_CONFIG_FILE: join(alias, basename(file)) });
});

it('T2-15 AC-M2-08 디렉터리와 FIFO를 읽거나 기다리지 않는다', () => {
  if (!posix) return rejected();
  unlinkSync(file);
  mkdirSync(file, { mode: 0o700 });
  rejected();
  expect(dirname(resolve(file))).toBe(resolve(directory));
  rmSync(file, { recursive: true });
  execFileSync('mkfifo', [file], { timeout: 5000 });
  rejected();
});
