import { writeFile } from 'node:fs/promises';
import { buildOperationalMap, legacyAnchorCorrespondence } from './operational';

const root = new URL('../../', import.meta.url);
await writeFile(new URL('resources/map/integration.json', root), `${JSON.stringify(buildOperationalMap(), null, 2)}\n`);
await writeFile(
  new URL('resources/map/integration-correspondence.json', root),
  `${JSON.stringify(legacyAnchorCorrespondence(), null, 2)}\n`,
);
console.log('통합판 운영 지도와 기존 앵커 대응표를 생성했습니다.');
