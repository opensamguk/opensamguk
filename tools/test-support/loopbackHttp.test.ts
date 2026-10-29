import { randomInt } from 'node:crypto';
import { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLoopbackHttp } from './loopbackHttp';

afterEach(() => vi.restoreAllMocks());

const handler = (_request: unknown, response: { end: () => void }) => response.end();
const bindError = (code: string) => Object.assign(new Error(`fixture bind ${code}`), { code });

describe('INT-01 AC-INT-01 bounded loopback HTTP fixture', () => {
  it.each(['EACCES', 'EADDRINUSE'])('reselects after Windows %s and sends real HTTP once', async (code) => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    listen.mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit('error', bindError(code)));
      return this;
    });
    let requests = 0;
    let uses = 0;
    const url = await withLoopbackHttp(
      (_request, response) => {
        requests++;
        response.end('owned fixture');
      },
      async (baseUrl) => {
        uses++;
        const response = await fetch(baseUrl);
        expect(await response.text()).toBe('owned fixture');
        return baseUrl;
      },
      { platform: 'win32' },
    );
    expect(uses).toBe(1);
    expect(requests).toBe(1);
    expect(listen.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(listen.mock.calls.length).toBeLessThanOrEqual(16);
    await expect(fetch(url)).rejects.toThrow();
  });

  it.each(['EACCES', 'EADDRINUSE'])('fails after exactly16 Windows %s errors and preserves each one', async (code) => {
    const errors = Array.from({ length: 16 }, () => bindError(code));
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
      const error = errors[listen.mock.calls.length - 1]!;
      queueMicrotask(() => this.emit('error', error));
      return this;
    });
    const use = vi.fn();
    const error = await withLoopbackHttp(handler, use, { platform: 'win32' }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(errors);
    expect(listen).toHaveBeenCalledTimes(16);
    expect(use).not.toHaveBeenCalled();
  });

  it.each([
    ['linux', 'EACCES'],
    ['darwin', 'EACCES'],
    ['win32', 'EPERM'],
    ['win32', 'EADDRNOTAVAIL'],
  ] as const)('immediately propagates %s %s without using HTTP', async (platform, code) => {
    const original = bindError(code);
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) {
      queueMicrotask(() => this.emit('error', original));
      return this;
    });
    const use = vi.fn();
    await expect(withLoopbackHttp(handler, use, { platform })).rejects.toBe(original);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(use).not.toHaveBeenCalled();
  });

  it('immediately propagates a synchronous invalid-port error', async () => {
    const nextPort = vi.fn(() => -1);
    const use = vi.fn();
    await expect(withLoopbackHttp(handler, use, { nextPort })).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
    expect(nextPort).toHaveBeenCalledTimes(1);
    expect(use).not.toHaveBeenCalled();
  });

  it('reselects after an actual owned loopback collision and leaves the first server available', async () => {
    await withLoopbackHttp(handler, async (occupied) => {
      let first = true;
      await withLoopbackHttp(
        handler,
        async (url) => {
          expect(url.port).not.toBe(occupied.port);
          expect(await (await fetch(url)).text()).toBe('');
          expect(await (await fetch(occupied)).text()).toBe('');
        },
        {
          nextPort: () => {
            if (first) {
              first = false;
              return Number(occupied.port);
            }
            return randomInt(10081, 65536);
          },
        },
      );
      expect(await (await fetch(occupied)).text()).toBe('');
    });
  });

  it('closes the actual listener and retains the original body error', async () => {
    const original = new Error('fixture body failed');
    let owned!: URL;
    await expect(
      withLoopbackHttp(handler, async (url) => {
        owned = url;
        throw original;
      }),
    ).rejects.toBe(original);
    await expect(fetch(owned)).rejects.toThrow();
  });

  it('retains both body and close errors after the actual listener closes', async () => {
    const bodyError = new Error('fixture body failed');
    const closeError = new Error('fixture close failed');
    const realClose = Server.prototype.close;
    vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
      return realClose.call(this, (error) => callback?.(error ?? closeError));
    });
    let owned!: URL;
    const error = await withLoopbackHttp(handler, async (url) => {
      owned = url;
      throw bodyError;
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([bodyError, closeError]);
    await expect(fetch(owned)).rejects.toThrow();
  });

  it('fails a successful body when close fails and still closes the actual listener', async () => {
    const closeError = new Error('fixture close failed');
    const realClose = Server.prototype.close;
    vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
      return realClose.call(this, (error) => callback?.(error ?? closeError));
    });
    let owned!: URL;
    await expect(
      withLoopbackHttp(handler, async (url) => {
        owned = url;
        return 'success';
      }),
    ).rejects.toBe(closeError);
    await expect(fetch(owned)).rejects.toThrow();
  });

  it('settles server.close and retains body, connection-close, and callback errors', async () => {
    const bodyError = new Error('fixture body failed');
    const connectionError = new Error('fixture connection cleanup failed');
    const closeError = new Error('fixture close failed');
    const realClose = Server.prototype.close;
    let closed = false;
    vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
      return realClose.call(this, (error) => {
        closed = true;
        callback?.(error ?? closeError);
      });
    });
    vi.spyOn(Server.prototype, 'closeAllConnections').mockImplementation(() => {
      throw connectionError;
    });
    const error = await withLoopbackHttp(handler, async () => {
      throw bodyError;
    }).catch((error: unknown) => error);
    expect(closed).toBe(true);
    expect((error as AggregateError).errors).toEqual([bodyError, connectionError, closeError]);
  });
});
