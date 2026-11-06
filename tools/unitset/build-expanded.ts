import { readFile, writeFile } from 'node:fs/promises';
import { operationalMapSchema } from '../../packages/rules/src/world/map/operational';
import { buildExpandedUnitSet } from './expanded';
import { readExpandedSource } from './source';

const root = new URL('../../', import.meta.url);
const source = await readExpandedSource();
const map = operationalMapSchema.parse(JSON.parse(await readFile(new URL('resources/map/san10.json', root), 'utf8')));
const result = buildExpandedUnitSet(source, map);
await writeFile(new URL('resources/unitset/expanded.json', root), `${JSON.stringify(result, null, 2)}\n`);
console.log(`INT-22 expanded: ${result.crewTypes.length}병종`);
