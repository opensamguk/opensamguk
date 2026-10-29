import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';

type BindOptions = {
  platform?: NodeJS.Platform;
  nextPort?: () => number;
};

// 시험 전용이다. Fetch 금지 포트의 최댓값10080보다 큰 후보를 직접 bind한다.
// https://fetch.spec.whatwg.org/#port-blocking
export async function withLoopbackHttp<T>(
  handler: RequestListener,
  use: (baseUrl: URL) => Promise<T>,
  { platform = process.platform, nextPort = () => randomInt(10081, 65536) }: BindOptions = {},
): Promise<T> {
  const server = createServer(handler);
  const bindErrors: unknown[] = [];
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      server.listen(nextPort(), '127.0.0.1');
      await once(server, 'listening');
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows의 사용 중인 주소는 EACCES일 수도 있다. HTTP 요청은 재전송하지 않는다.
      if (code !== 'EADDRINUSE' && !(platform === 'win32' && code === 'EACCES')) throw error;
      bindErrors.push(error);
    }
  }
  if (!server.listening)
    throw new AggregateError(bindErrors, 'loopback HTTP fixture port unavailable after 16 atomic binds');

  const failures: unknown[] = [];
  let result!: T;
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('loopback address missing');
    result = await use(new URL(`http://127.0.0.1:${address.port}`));
  } catch (error) {
    failures.push(error);
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  try {
    server.closeAllConnections();
  } catch (error) {
    failures.push(error);
  }
  try {
    await closed;
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'loopback HTTP fixture body or cleanup failed');
  return result;
}
