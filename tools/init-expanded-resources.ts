import { createDb } from '../packages/db/src/index';
import { initializeExpandedResources } from './expanded-resources';

if (!process.env.DATABASE_URL) throw Error('DATABASE_URL이 없습니다.');
const db = createDb(process.env.DATABASE_URL);
try {
  console.log(JSON.stringify(await initializeExpandedResources(db)));
} finally {
  await db.$disconnect();
}
