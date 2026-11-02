// SSE 본문을 저장하지 않고 실제 ready 프레임만 확인한다.
export class LoadSseParser {
  readonly #decoder = new TextDecoder();
  #buffer = '';
  ready = false;

  feed(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    if (this.#buffer.length > 65_536) throw new Error('LOAD_SSE_FRAME_TOO_LARGE');
    this.#buffer = this.#buffer.replaceAll('\r\n', '\n');
    let boundary: number;
    while ((boundary = this.#buffer.indexOf('\n\n')) !== -1) {
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      const lines = frame.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      if (event === 'ready') {
        const text = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new Error('LOAD_SSE_READY_INVALID');
        }
        if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'ready')
          throw new Error('LOAD_SSE_READY_INVALID');
        this.ready = true;
      }
    }
  }
}
export function expectedOwnedAbort(error: unknown, signal: AbortSignal, stopping: boolean): boolean {
  return stopping && signal.aborted && error instanceof Error && error.name === 'AbortError';
}

export async function settleLoadSseReader(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel' | 'closed' | 'releaseLock'>,
  signal: AbortSignal,
  stopping: boolean,
): Promise<boolean> {
  const results = await Promise.allSettled([Promise.resolve().then(() => reader.cancel()), reader.closed]);
  let confirmed = results.every(
    (result) => result.status === 'fulfilled' || expectedOwnedAbort(result.reason, signal, stopping),
  );
  try {
    reader.releaseLock();
  } catch {
    confirmed = false;
  }
  return confirmed;
}
