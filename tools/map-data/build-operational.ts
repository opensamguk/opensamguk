import { writeFile } from 'node:fs/promises';
import { buildOperationalMap, legacyAnchorCorrespondence } from './operational';
import { createDb, readPublishedResources } from '../../packages/db/src/index';

const root = new URL('../../', import.meta.url);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 필요합니다.');
const db = createDb(process.env.DATABASE_URL);
let legacy: unknown;
try {
  const [row] = await readPublishedResources(db, [{ kind: 'MAP', name: 'che', version: 1 }]);
  legacy = row!.content;
} finally {
  await db.$disconnect();
}
await writeFile(
  new URL('resources/map/integration.json', root),
  `${JSON.stringify(buildOperationalMap(legacy), null, 2)}\n`,
);
await writeFile(
  new URL('resources/map/integration-correspondence.json', root),
  `${JSON.stringify(legacyAnchorCorrespondence(legacy), null, 2)}\n`,
);
console.log('통합판 운영 지도와 기존 앵커 대응표를 생성했습니다.');
