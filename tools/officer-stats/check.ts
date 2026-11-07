import { readFile } from 'node:fs/promises';
import { auditOfficerLedger, mainScenarioSourceText } from './audit';
import { createDb, readPublishedResources } from '../../packages/db/src/index';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
const db = createDb(process.env.DATABASE_URL);
let main: string;
try {
  const [row] = await readPublishedResources(db, [{ kind: 'SCENARIO', name: '1030', version: 1 }]);
  main = mainScenarioSourceText(row!.content);
} finally {
  await db.$disconnect();
}
const [sources, ledger] = await Promise.all([
  read('tools/fixtures/int16-selected-officers.json'),
  read('resources/officers/191-five-stats.json'),
]);
const rows = auditOfficerLedger(main, sources, JSON.parse(ledger));
console.log(`AC-INT-16: ${rows.length}/491명 5능력치·출처·인물 ID·독립 리뷰를 확인했습니다.`);
