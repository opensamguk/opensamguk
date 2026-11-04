import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertNotificationRoutes,
  fixtureDatabase,
  startReceiver,
  TRIAL_CONTENT,
} from './notifications-browser/fixture';
import NotificationReporter from './notifications-browser/reporter';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});
const localDatabase = 'postgresql://127.0.0.1/notification_browser_test';
it('운영 실행을 DB 연결과 서버 생성 전에 거부한다', () => {
  expect(() => fixtureDatabase({ NODE_ENV: 'production', DATABASE_URL: localDatabase })).toThrow('운영');
  expect(fixtureDatabase({ DATABASE_URL: localDatabase })).toBe(localDatabase);
});
it.each([
  undefined,
  'not-a-url',
  'postgresql://remote.example.test/database_test',
  'postgresql://127.0.0.1/production',
  'https://127.0.0.1/database_test',
  `${localDatabase}?host=remote.example.test`,
  `${localDatabase}?port=5432`,
  `${localDatabase}#fragment`,
])('잘못된 DB 주소를 가린 고정 오류로 거부한다 (%#)', (url) => {
  expect(() => fixtureDatabase({ DATABASE_URL: url })).toThrow('loopback 전용 테스트 DB가 필요합니다.');
});
const routes = ['notification.get', 'notification.setDiscord', 'notification.setEvents', 'notification.removeDiscord'];
it.each(routes)('API %s가 없으면 skip 전에 시작을 거부한다', (missing) => {
  expect(() =>
    assertNotificationRoutes(
      Object.fromEntries(routes.filter((route) => route !== missing).map((route) => [route, {}])),
    ),
  ).toThrow('알림 API 네 개');
});

async function receiptFile() {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-notification-browser-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'receipt.json');
}
const validReceipt = { requests: 1, valid: 1, invalid: 0, method: 'POST', content: TRIAL_CONTENT };
it('자기 HTTP 수신기는 실제 POST 한 번만 받고 비밀 없이 영수증을 남긴 뒤 닫힌다', async () => {
  const path = await receiptFile();
  const receiver = await startReceiver(path);
  cleanups.push(receiver.close);
  const response = await receiver.transport(
    'https://discord.com/api/webhooks/100000000000000001/e2e-fake-token_0123456789abcdefWX34',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: TRIAL_CONTENT, allowed_mentions: { parse: [] } }),
      redirect: 'manual',
      signal: new AbortController().signal,
    },
  );
  expect(response.status).toBe(204);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(validReceipt);
  await expect(
    receiver.transport('https://discord.com/api/webhooks/1/other-private-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('정해진 가짜 주소');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(validReceipt);
  await receiver.close();
  cleanups.pop();
  await expect(fetch(receiver.origin)).rejects.toThrow();
});
it('잘못된 요청 본문과 경로는 수신 영수증에 남기지 않는다', async () => {
  const path = await receiptFile();
  const receiver = await startReceiver(path);
  cleanups.push(receiver.close);
  const response = await fetch(`${receiver.origin}/private-token`, { method: 'POST', body: 'private-token' });
  expect(response.status).toBe(400);
  const text = await readFile(path, 'utf8');
  expect(text).not.toContain('private-token');
  expect(JSON.parse(text)).toEqual({ requests: 1, valid: 0, invalid: 1, method: null, content: null });
});
it.each(['valid', 'skip', 'retry', 'duplicate', 'missing', 'two-posts'] as const)(
  '종료 판정은 두 실제 성공과 POST 하나를 요구한다 (%s)',
  async (kind) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = await receiptFile();
    await writeFile(path, JSON.stringify({ ...validReceipt, requests: kind === 'two-posts' ? 2 : 1 }));
    const reporter = new NotificationReporter({ receiptPath: path });
    reporter.onTestEnd({ id: 'first', expectedStatus: 'passed' }, { status: 'passed', retry: 0 });
    if (kind !== 'missing')
      reporter.onTestEnd(
        { id: kind === 'duplicate' ? 'first' : 'second', expectedStatus: 'passed' },
        { status: kind === 'skip' ? 'skipped' : 'passed', retry: kind === 'retry' ? 1 : 0 },
      );
    expect(await reporter.onEnd({ status: 'passed' })).toEqual({ status: kind === 'valid' ? 'passed' : 'failed' });
  },
);
