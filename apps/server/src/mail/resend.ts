import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { MailTransport } from './transport';

const endpoint = 'https://api.resend.com/emails';
const failure = '계정 메일을 보내지 못했습니다.';
const configurationFailure = '메일 전송 설정을 확인하세요.';

function apiKey(file: string | undefined): string {
  if (!file || !isAbsolute(file)) throw new Error(configurationFailure);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) throw new Error(configurationFailure);
    const key = readFileSync(descriptor, 'utf8').trim();
    if (!/^re_[A-Za-z0-9_-]{8,512}$/.test(key)) throw new Error(configurationFailure);
    return key;
  } catch {
    // 파일 경로·키·원래 오류는 시작 로그에도 포함하지 않는다.
    throw new Error(configurationFailure);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** 서비스 선택 뒤 명시적으로 구성하는 후보다. 목적지는 환경변수로 바꾸지 않는다. */
export function createResendTransport(
  env: NodeJS.ProcessEnv,
  { request = fetch, timeoutMs = 10_000 }: { request?: typeof fetch; timeoutMs?: number } = {},
): MailTransport {
  const from = z.email().max(254).safeParse(env.MAIL_FROM);
  if (!from.success || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
    throw new Error(configurationFailure);
  }
  const key = apiKey(env.MAIL_API_KEY_FILE);
  return {
    async send(message) {
      const payload = JSON.stringify({
        from: from.data,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      });
      // 같은 인증 링크의 재전송은 같은 키다. 원문 주소·토큰은 헤더에 넣지 않는다.
      const idempotencyKey = 'opensamguk-account/' + createHash('sha256').update(payload).digest('hex');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      let response: Response | undefined;
      try {
        response = await request(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: payload,
        });
        if (!response.ok || !response.body) throw new Error(failure);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 8192) throw new Error(failure);
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        const receipt: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!z.object({ id: z.uuid() }).safeParse(receipt).success) throw new Error(failure);
        controller.signal.throwIfAborted();
        // API의 접수 성공만 확인한다. 실제 수신은 별도 운영 인수에서 확인한다.
      } catch {
        // 공급자의 응답 본문·오류·요청 헤더를 외부 오류나 로그로 전달하지 않는다.
        throw new Error(failure);
      } finally {
        clearTimeout(timer);
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
      }
    },
  };
}
