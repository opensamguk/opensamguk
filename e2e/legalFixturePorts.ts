import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';

type BindOptions = {
  platform?: NodeJS.Platform;
  nextPort?: () => number;
};

// 시험 전용이며 준비된 listener의 bind만 다시 한다. 요청이나 서버 생성은 반복하지 않는다.
export async function listenLegalLoopback<T>(
  listen: (port: number) => Promise<T>,
  listening: () => boolean,
  { platform = process.platform, nextPort = () => randomInt(20_000, 50_000) }: BindOptions = {},
): Promise<T> {
  const errors: unknown[] = [];
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return await listen(nextPort());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
      if (listening() || (code !== 'EADDRINUSE' && !(platform === 'win32' && code === 'EACCES'))) throw error;
      errors.push(error);
    }
  }
  throw new AggregateError(errors, 'legal fixture loopback unavailable after 16 atomic binds');
}

export async function listenLegalHttp(server: Server, options?: BindOptions): Promise<void> {
  await listenLegalLoopback(
    (port) =>
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          server.removeListener('error', failed);
          server.removeListener('listening', ready);
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        server.once('error', failed);
        server.once('listening', ready);
        try {
          server.listen(port, '127.0.0.1');
        } catch (error) {
          cleanup();
          reject(error);
        }
      }),
    () => server.listening,
    options,
  );
}
