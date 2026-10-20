import { parseArgs } from 'node:util';
import { createDb } from '@opensamguk/db';
import { controlClock, type ClockAction } from '../world/clock';

async function main() {
  const action = process.argv[2];
  if (!['start', 'pause', 'resume', 'status'].includes(action ?? '')) throw new Error('알 수 없는 시계 명령입니다.');
  const { values } = parseArgs({ args: process.argv.slice(3), options: { world: { type: 'string' } } });
  if (!values.world || !process.env.DATABASE_URL) throw new Error('--world <월드 ID>와 DATABASE_URL이 필요합니다.');
  const db = createDb(process.env.DATABASE_URL);
  try {
    console.log(JSON.stringify(await controlClock(db, values.world, action as ClockAction)));
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '월드 명령 실패');
  process.exitCode = 1;
});
