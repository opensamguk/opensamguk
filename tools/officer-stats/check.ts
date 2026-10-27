import { readFile } from 'node:fs/promises';
import { auditOfficerLedger } from './audit';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const [main, sources, ledger] = await Promise.all([
  read('resources/scenario/1030.json'),
  read('tools/fixtures/int16-selected-officers.json'),
  read('resources/officers/191-five-stats.json'),
]);
const rows = auditOfficerLedger(main, sources, JSON.parse(ledger));
console.log(`AC-INT-16: ${rows.length}/491명 5능력치·출처·인물 ID·독립 리뷰를 확인했습니다.`);
