import { createDb } from '../packages/db/src/index';
import { initializeSan10Resources } from './san10-resources';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL이 없습니다.');
const db = createDb(process.env.DATABASE_URL);
try {
  console.log(JSON.stringify(await initializeSan10Resources(db)));
} finally {
  await db.$disconnect();
}
