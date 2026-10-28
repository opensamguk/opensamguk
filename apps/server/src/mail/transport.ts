import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createResendTransport } from './resend';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** 개발 메일함 또는 서비스 선택 뒤 명시적으로 설정한 HTTPS 전송을 쓴다. */
export function createMailTransport(env: NodeJS.ProcessEnv = process.env): MailTransport {
  if (env.MAIL_TRANSPORT === 'resend') return createResendTransport(env);
  if (env.MAIL_TRANSPORT !== 'capture' || env.NODE_ENV === 'production') {
    throw new Error('메일 전송 설정을 확인하세요.');
  }
  const configured = env.MAIL_CAPTURE_DIR ?? '.mail-outbox';
  if (!configured.trim()) throw new Error('개발 메일함 경로를 확인하세요.');
  const directory = resolve(configured);
  return {
    async send(message) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const basename = randomUUID();
      const pending = join(directory, basename + '.tmp');
      // 완성된 JSON만 메일함에 공개한다. 주소·링크·토큰을 파일명이나 로그에 넣지 않는다.
      await writeFile(pending, JSON.stringify({ ...message, sentAt: new Date().toISOString() }), {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        await rename(pending, join(directory, basename + '.json'));
      } catch (error) {
        await unlink(pending).catch(() => undefined);
        throw error;
      }
    },
  };
}
