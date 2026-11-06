import { createDb } from '../packages/db/src/index';
import { registerMapBackground } from '../apps/server/src/resourceAdmin/mapBackground';
import { readMapBackgroundImage } from './map-base/background';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== 'register') throw new Error('invalid command');
  process.stdin.setEncoding('utf8');
  let body = '';
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 4096) throw new Error('invalid input');
  }
  const image = readMapBackgroundImage(JSON.parse(body) as unknown);
  if (!process.env.DATABASE_URL) throw new Error('missing database');
  const db = createDb(process.env.DATABASE_URL);
  try {
    const result = await registerMapBackground(db, image);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write(
    '지도 바탕 그림을 등록하지 못했습니다. 명령·표준 입력·이미지 커밋·게시 판·DB 설정을 확인하세요.\n',
  );
  process.exitCode = 1;
});
