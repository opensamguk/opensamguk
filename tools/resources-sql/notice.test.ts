import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  APPEND_HEADING,
  checkNoticeAppendOnly,
  gitBlobSha1,
  INITIAL_NOTICE_FIXTURE,
  INITIAL_NOTICE_GIT_BLOB,
  INITIAL_NOTICE_LF_BYTES,
  INITIAL_NOTICE_SHA256,
  verifyInitialNotice,
} from './notice';

const root = new URL('../../', import.meta.url);
const rawInitial = await readFile(new URL(INITIAL_NOTICE_FIXTURE, root), 'utf8');
const initial = rawInitial.replaceAll('\r\n', '\n');
const tournament = '- 토너먼트 경기: core2026 df6c926; MIT (c) 2025 devsam.';
const appended = `${initial}\n${APPEND_HEADING}\n\n${tournament}\n`;

describe('T4-77 S2 NOTICE 원문과 추가 출처', () => {
  it('NT1 역사 고정물은 Git 원장의 blob·해시·바이트 수와 같다', () => {
    expect(gitBlobSha1(initial)).toBe(INITIAL_NOTICE_GIT_BLOB);
    expect(createHash('sha256').update(initial).digest('hex')).toBe(INITIAL_NOTICE_SHA256);
    expect(Buffer.byteLength(initial)).toBe(INITIAL_NOTICE_LF_BYTES);
    expect(verifyInitialNotice(rawInitial)).toBe(initial);
  });

  it('NT2 빈 글과 hello의 Git blob 해시를 계산한다', () => {
    expect(gitBlobSha1('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobSha1('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('NT3 현재 NOTICE는 원문과 덧붙임 계약을 지킨다', async () => {
    const current = await readFile(new URL('resources/NOTICE.md', root), 'utf8');
    expect(() => checkNoticeAppendOnly(current, initial)).not.toThrow();
  });

  it('NT4 덧붙이지 않은 원문을 받는다', () => {
    expect(() => checkNoticeAppendOnly(initial, initial)).not.toThrow();
  });

  it('NT5 끝의 정해진 절에 추가 출처를 받는다', () => {
    expect(() => checkNoticeAppendOnly(appended, initial)).not.toThrow();
  });

  it('NT6 11줄에 끼운 출처를 원문 변조로 거부한다', () => {
    const lines = initial.split('\n');
    lines.splice(10, 0, tournament);
    expect(() => checkNoticeAppendOnly(lines.join('\n'), initial)).toThrow('NOTICE 원문 변조: 11');
  });

  it('NT7 원문 저작권 연도 변경을 거부한다', () => {
    expect(() => checkNoticeAppendOnly(initial.replace('2025 devsam', '2024 devsam'), initial)).toThrow(
      'NOTICE 원문 변조:',
    );
  });

  it('NT8 초상 고지 삭제를 거부한다', () => {
    const removed = initial.slice(0, initial.indexOf('## 초상 메타데이터와 한자 독음 표'));
    expect(() => checkNoticeAppendOnly(removed, initial)).toThrow('NOTICE 원문 변조:');
  });

  it('NT9 제목 누락·중복과 잘못된 끝 줄바꿈을 거부한다', () => {
    for (const current of [
      `${initial}${tournament}\n`,
      `${appended}\n${APPEND_HEADING}\n`,
      appended.slice(0, -1),
      `${appended}\n`,
    ]) {
      expect(() => checkNoticeAppendOnly(current, initial)).toThrow('NOTICE 덧붙임 위치 오류');
    }
  });

  it('NT10 CRLF는 같은 판정을 받고 NUL은 거부한다', () => {
    const crlf = (text: string) => text.replaceAll('\n', '\r\n');
    expect(verifyInitialNotice(crlf(initial))).toBe(initial);
    expect(() => checkNoticeAppendOnly(crlf(initial), initial)).not.toThrow();
    expect(() => checkNoticeAppendOnly(crlf(appended), crlf(initial))).not.toThrow();
    expect(() => checkNoticeAppendOnly(`${appended}\0`, initial)).toThrow('NOTICE에 NUL 문자가 있습니다');
  });

  it('NT11 바뀐 역사 고정물을 거부한다', () => {
    expect(() => verifyInitialNotice(initial.replace('2025 devsam', '2024 devsam'))).toThrow(
      '초기 NOTICE 고정값 불일치',
    );
  });
});
