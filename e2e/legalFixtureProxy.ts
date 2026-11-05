import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

export async function proxyLegalRequest(
  url: string,
  incoming: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming.headers))
    if (value !== undefined && !['host', 'connection', 'transfer-encoding'].includes(key))
      headers[key] = Array.isArray(value) ? value.join(',') : value;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.from(chunk as Uint8Array);
    length += bytes.length;
    if (length > 1_048_576) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(bytes);
  }
  const method = incoming.method ?? 'GET';
  const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
    // SSE 취소 뒤 fetch 풀이 여는 무요청 소켓이 API 종료를 막지 않게 한다.
    const outgoing = request(url, { method, headers, signal, agent: false }, resolve);
    outgoing.once('error', reject);
    outgoing.end(method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks));
  });
  try {
    response.statusCode = upstream.statusCode ?? 502;
    for (const [key, value] of Object.entries(upstream.headers))
      if (value !== undefined && !['connection', 'transfer-encoding'].includes(key)) response.setHeader(key, value);
    await pipeline(upstream, response, { signal });
  } finally {
    upstream.destroy();
  }
}
