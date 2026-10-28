import { createDb } from '../packages/db/src/index';
import { changeAdminRole } from '../apps/server/src/admin/roleStore';
import { z } from 'zod';

const requestSchema = z.strictObject({ email: z.string(), reason: z.string() });

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['grant', 'revoke'].includes(args[0]!)) throw new Error('invalid command');
  process.stdin.setEncoding('utf8');
  let body = '';
  for await (const chunk of process.stdin) {
    body += String(chunk);
    if (Buffer.byteLength(body) > 4096) throw new Error('invalid input');
  }
  const input = requestSchema.parse(JSON.parse(body) as unknown);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('missing database');
  const db = createDb(url);
  try {
    const result = await changeAdminRole(db, { ...input, role: args[0] === 'grant' ? 'ADMIN' : 'USER' });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally {
    await db.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write('관리자 권한을 변경하지 못했습니다. 명령·표준 입력·대상 계정·DB 설정을 확인하세요.\n');
  process.exitCode = 1;
});
