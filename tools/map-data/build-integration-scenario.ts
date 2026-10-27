import { writeFile } from 'node:fs/promises';
import { buildIntegrationScenario } from './integration-scenario';
import { FIVE_STAT_RULES } from '../../packages/rules/src/general/fiveStats';
import { integrationResourceRows } from '../integration-resources';

const root = new URL('../../', import.meta.url);
const { scenario, removed, relocations } = buildIntegrationScenario();
await writeFile(new URL('resources/scenario/integration191.json', root), `${JSON.stringify(scenario, null, 2)}\n`);
await writeFile(
  new URL('resources/scenario/integration191-correspondence.json', root),
  `${JSON.stringify({ removed, relocations }, null, 2)}\n`,
);
await writeFile(
  new URL('resources/scenario/five-stats.json', root),
  `${JSON.stringify(
    {
      $comment: 'OpenSamguk D-038 five-stats initial rules; docs/product/five-stats.md; MIT.',
      stat: { ...FIVE_STAT_RULES, npcTotal: 250, npcMin: 10, npcMax: 85, chiefMin: 65 },
      iconPath: '.',
    },
    null,
    2,
  )}\n`,
);
console.log('통합판191년 시나리오·대응표·5능력치 규칙을 생성했습니다.');
const resources = await integrationResourceRows();
await writeFile(
  new URL('resources/integration-manifest.json', root),
  `${JSON.stringify(
    resources.map(({ kind, name, version, contentHash, source }) => ({ kind, name, version, contentHash, source })),
    null,
    2,
  )}\n`,
);
