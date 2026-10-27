import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function accountMailLink(email: string, subject: string, after: number): Promise<string> {
  const directory = process.env.MAIL_CAPTURE_DIR
    ? resolve(process.env.MAIL_CAPTURE_DIR)
    : fileURLToPath(new URL('../apps/server/.mail-outbox/', import.meta.url));
  const deadline = Date.now() + 8000;
  do {
    let files: string[] = [];
    try {
      files = await readdir(directory);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw new Error('시험 메일함을 읽지 못했습니다.', { cause: error });
    }
    const messages = await Promise.all(
      files
        .filter((file) => /^[0-9a-f-]+\.json$/.test(file))
        .map(async (file) => {
          try {
            return JSON.parse(await readFile(resolve(directory, file), 'utf8')) as {
              to: string;
              subject: string;
              text: string;
              sentAt: string;
            };
          } catch {
            throw new Error('완성된 시험 메일을 읽지 못했습니다.');
          }
        }),
    );
    const message = messages
      .filter((value) => value.to === email && value.subject === subject && Date.parse(value.sentAt) >= after)
      .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))[0];
    const link = message?.text.match(/https?:\/\/\S+/u)?.[0];
    if (link) return link;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('시험 메일을 기한 안에 받지 못했습니다.');
}
