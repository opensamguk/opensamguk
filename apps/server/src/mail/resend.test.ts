import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { accountMail } from './templates';
import { createResendTransport } from './resend';
import { createMailTransport } from './transport';

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const key = 're_LOCAL_TEST_VALUE_ONLY_123456';
const receipt = { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' };
const message = accountMail('recipient@example.invalid', 'VERIFY_EMAIL', 'https://game.example', 'T'.repeat(43));

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  }
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^opensamguk-resend-[A-Za-z0-9]+$/);
    await rm(target, { recursive: true, force: true });
  }
});

async function configuration(contents = key) {
  const directory = await mkdtemp(join(tmpdir(), 'opensamguk-resend-'));
  directories.push(directory);
  const file = join(directory, 'api-key');
  await writeFile(file, contents, { flag: 'wx', mode: 0o600 });
  return {
    NODE_ENV: 'production',
    MAIL_TRANSPORT: 'resend',
    MAIL_FROM: 'accounts@example.invalid',
    MAIL_API_KEY_FILE: file,
  };
}

async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((done, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', done);
  });
  const url = `http://127.0.0.1:${(instance.address() as AddressInfo).port}/emails`;
  return {
    url,
    request: ((input, options) => {
      expect(input).toBe('https://api.resend.com/emails');
      return fetch(url, options);
    }) as typeof fetch,
  };
}

it('실제 HTTP로 발신·본문을 보내고 같은 링크의 멱등 키를 유지한다', async () => {
  const received: Array<{ headers: IncomingMessage['headers']; body: unknown }> = [];
  const local = await server((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(receipt));
    });
  });
  const transport = createResendTransport(await configuration(), { request: local.request });
  await transport.send(message);
  await transport.send(message);
  await transport.send({ ...message, text: message.text + '\n다른 링크' });
  expect(received).toHaveLength(3);
  expect(received[0]!.body).toEqual({
    from: 'accounts@example.invalid',
    to: [message.to],
    subject: message.subject,
    text: message.text,
  });
  expect(received[0]!.headers.authorization).toBe('Bearer ' + key);
  const first = received[0]!.headers['idempotency-key'];
  expect(first).toMatch(/^opensamguk-account\/[0-9a-f]{64}$/);
  expect(received[1]!.headers['idempotency-key']).toBe(first);
  expect(received[2]!.headers['idempotency-key']).not.toBe(first);
  expect(first).not.toContain(message.to);
  expect(first).not.toContain('T'.repeat(43));
});

it.each([400, 401, 429, 500])('공급자 %s 응답의 민감 본문을 노출하거나 자동 재시도하지 않는다', async (status) => {
  let requests = 0;
  const local = await server((_request, response) => {
    requests++;
    response.writeHead(status).end(key + message.to + message.text);
  });
  const transport = createResendTransport(await configuration(), { request: local.request });
  const error = await transport.send(message).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toBe('Error: 계정 메일을 보내지 못했습니다.');
  expect((error as Error).cause).toBeUndefined();
  expect(requests).toBe(1);
});

it('실제 redirect를 따라가서 인증 헤더를 다른 서버로 보내지 않는다', async () => {
  let redirected = 0;
  const other = await server((_request, response) => {
    redirected++;
    response.end(JSON.stringify(receipt));
  });
  const local = await server((_request, response) => response.writeHead(307, { Location: other.url }).end());
  const transport = createResendTransport(await configuration(), { request: local.request });
  await expect(transport.send(message)).rejects.toThrow('계정 메일을 보내지 못했습니다.');
  expect(redirected).toBe(0);
});

it.each(['headers', 'body'])('%s가 오지 않는 실제 HTTP 요청은 응답 처리까지 제한 시간으로 끊는다', async (stage) => {
  const local = await server((_request, response) => {
    if (stage === 'body') response.writeHead(200, { 'Content-Type': 'application/json' }).write('{"id":"');
  });
  const transport = createResendTransport(await configuration(), { request: local.request, timeoutMs: 100 });
  const started = Date.now();
  await expect(transport.send(message)).rejects.toThrow('계정 메일을 보내지 못했습니다.');
  expect(Date.now() - started).toBeLessThan(3000);
});

it.each(['not-json', '{}', '{"id":"not-a-receipt"}', 'x'.repeat(8193)])(
  '잘못되거나 큰 접수 본문을 성공으로 세지 않는다 (#%#)',
  async (body) => {
    const local = await server((_request, response) => response.writeHead(200).end(body));
    const transport = createResendTransport(await configuration(), { request: local.request });
    await expect(transport.send(message)).rejects.toThrow('계정 메일을 보내지 못했습니다.');
  },
);

it('명시한 후보 설정만 만들고 운영 capture·미설정은 계속 거부한다', async () => {
  expect(createMailTransport(await configuration()).send).toBeTypeOf('function');
  expect(() => createMailTransport({ NODE_ENV: 'production' })).toThrow('메일 전송 설정을 확인하세요.');
  expect(() => createMailTransport({ NODE_ENV: 'production', MAIL_TRANSPORT: 'capture' })).toThrow();
});

it.each(['', 'not-a-key', 're_example\nInjected: value', 'x'.repeat(4097)])(
  '잘못된 비밀 파일은 내용을 노출하지 않고 거부한다 (#%#)',
  async (contents) => {
    const env = await configuration(contents);
    expect(() => createResendTransport(env)).toThrow(/^메일 전송 설정을 확인하세요\.$/);
  },
);

it('없는/상대 비밀 파일과 헤더 주입 발신 주소를 시작 전에 거부한다', async () => {
  const env = await configuration();
  for (const file of [undefined, 'relative-secret', join(dirname(env.MAIL_API_KEY_FILE), 'missing')]) {
    expect(() => createResendTransport({ ...env, MAIL_API_KEY_FILE: file })).toThrow(/^메일 전송 설정을 확인하세요\.$/);
  }
  expect(() =>
    createResendTransport({ ...env, MAIL_FROM: 'sender@example.invalid\nBcc: victim@example.invalid' }),
  ).toThrow();
  expect(() => createResendTransport(env, { timeoutMs: 10_001 })).toThrow();
});
