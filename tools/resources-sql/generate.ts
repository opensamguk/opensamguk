import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { convertResourcesToSql, RESOURCE_INPUTS, type ResourceTexts } from './convert';

const root = new URL('../../', import.meta.url);
const input = Object.fromEntries(
  await Promise.all(
    RESOURCE_INPUTS.map(async (resource) => [resource.slot, await readFile(new URL(resource.path, root), 'utf8')]),
  ),
) as ResourceTexts;
const sql = convertResourcesToSql(input, await readFile(new URL('resources/NOTICE.md', root), 'utf8'));
const output = new URL('packages/db/sql/resources-init.sql', root);
await mkdir(new URL('./', output), { recursive: true });
await writeFile(output, sql, 'utf8');
console.log(`초기화 SQL 생성: ${fileURLToPath(output)} (자원 5)`);
