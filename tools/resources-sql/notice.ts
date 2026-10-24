import { createHash } from 'node:crypto';

export const INITIAL_NOTICE_FIXTURE = 'tools/fixtures/t4-77-initial-notice.txt';
export const INITIAL_NOTICE_SOURCE_COMMIT = 'f3f6e5ad5a6afc59c146568eaa5f2754fdd605ae';
export const INITIAL_NOTICE_GIT_BLOB = '9f9243be13e07b6dc3fb2981949cf2d235324dbe';
export const INITIAL_NOTICE_SHA256 = 'b756a3c6192a2ca21b0473996c426186392727c553d550a62b68e939163ff972';
export const INITIAL_NOTICE_LF_BYTES = 4089;
export const APPEND_HEADING = '## S2 이후 추가 출처';

export function gitBlobSha1(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function verifyInitialNotice(text: string): string {
  const normalized = text.replaceAll('\r\n', '\n');
  if (
    Buffer.byteLength(normalized, 'utf8') !== INITIAL_NOTICE_LF_BYTES ||
    gitBlobSha1(normalized) !== INITIAL_NOTICE_GIT_BLOB ||
    createHash('sha256').update(normalized, 'utf8').digest('hex') !== INITIAL_NOTICE_SHA256
  ) {
    throw new Error('초기 NOTICE 고정값 불일치');
  }
  return normalized;
}

export function checkNoticeAppendOnly(current: string, initial: string): void {
  const normalized = current.replaceAll('\r\n', '\n');
  const prefix = initial.replaceAll('\r\n', '\n');
  if (normalized.includes('\0')) throw new Error('NOTICE에 NUL 문자가 있습니다');
  if (!normalized.startsWith(prefix)) {
    let index = 0;
    while (index < normalized.length && index < prefix.length && normalized[index] === prefix[index]) index++;
    const line = prefix.slice(0, index).split('\n').length;
    throw new Error(`NOTICE 원문 변조: ${line}`);
  }
  const appended = normalized.slice(prefix.length);
  if (appended === '') return;
  if (
    !appended.startsWith(`\n${APPEND_HEADING}\n`) ||
    appended.split('\n').filter((line) => line === APPEND_HEADING).length !== 1 ||
    !appended.endsWith('\n') ||
    appended.endsWith('\n\n')
  ) {
    throw new Error('NOTICE 덧붙임 위치 오류');
  }
}
