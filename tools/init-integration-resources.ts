import { createDb } from '../packages/db/src/index';
import { initializeIntegrationResources } from './integration-resources';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
const db = createDb(process.env.DATABASE_URL);
try {
  const result = await initializeIntegrationResources(db);
  console.log(`통합판 자원 저장: 삽입 ${result.inserted}, 기존 ${result.existing}`);
} finally {
  await db.$disconnect();
}
