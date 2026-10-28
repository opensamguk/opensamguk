import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { newAccountToken } from '../auth/accountToken';
import { accountMail } from './templates';
import { createMailTransport } from './transport';

const owned: string[] = [];
afterEach(async () => {
  for (const directory of owned.splice(0)) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^opensamguk-mail-[A-Za-z0-9]+$/);
    await rm(target, { recursive: true, force: true });
  }
});

describe('계정 메일', () => {
  it.each(['VERIFY_EMAIL', 'RESET_PASSWORD'] as const)('%s 토큰은 URL 조각에만 넣는다', (purpose) => {
    const { token } = newAccountToken(purpose, 0);
    const mail = accountMail('tester@example.invalid', purpose, 'https://game.example', token);
    const url = new URL(mail.text.split('\n\n')[1]!);
    expect(url.origin).toBe('https://game.example');
    expect(url.pathname).toBe(purpose === 'VERIFY_EMAIL' ? '/verify-email' : '/reset-password');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=' + token);
    expect(mail.subject).not.toContain(token);
  });

  it.each([
    'https://name:password@example.invalid',
    'https://example.invalid/path',
    'https://example.invalid/?token=x',
    'https://example.invalid/#x',
    'javascript:alert(1)',
  ])('메일 링크의 잘못된 출처 %s를 거부한다', (origin) => {
    expect(() => accountMail('tester@example.invalid', 'VERIFY_EMAIL', origin, 'A'.repeat(43))).toThrow();
  });

  it('실제 capture 파일에 완성된 메일을 쓰고 파일명에 수신자나 토큰을 넣지 않는다', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opensamguk-mail-'));
    owned.push(directory);
    const transport = createMailTransport({ NODE_ENV: 'test', MAIL_TRANSPORT: 'capture', MAIL_CAPTURE_DIR: directory });
    const { token } = newAccountToken('VERIFY_EMAIL', 0);
    const message = accountMail('tester@example.invalid', 'VERIFY_EMAIL', 'http://127.0.0.1:5173', token);
    await Promise.all([transport.send(message), transport.send(message)]);
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(/^[0-9a-f-]{36}\.json$/);
      expect(file).not.toContain(token);
      expect(file).not.toContain(message.to);
      const { sentAt, ...stored } = JSON.parse(await readFile(join(directory, file), 'utf8'));
      expect(Number.isFinite(Date.parse(sentAt))).toBe(true);
      expect(stored).toEqual(message);
    }
  });

  it.each([
    { NODE_ENV: 'production', MAIL_TRANSPORT: 'capture' },
    { NODE_ENV: 'test' },
    { NODE_ENV: 'test', MAIL_TRANSPORT: 'smtp' },
  ])('설정되지 않은 전송과 운영 capture를 거부한다', (env) => {
    expect(() => createMailTransport(env)).toThrow();
  });
});
