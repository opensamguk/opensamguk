import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { monthlyFixture } from './monthlyFixture';
import { initialReplayState, settleReplayMonth } from '@opensamguk/rules';
import { hashState } from '@opensamguk/shared/node';

const path = new URL('./fixtures/monthly-initial.json', import.meta.url);
const formatting = await resolveConfig(fileURLToPath(import.meta.url));
const serialize = (value: unknown) => format(JSON.stringify(value), { ...formatting, parser: 'json' });
const fixture = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
fixture.initial = await monthlyFixture();
await writeFile(path, await serialize(fixture));
const initial = await monthlyFixture();
const replay = settleReplayMonth(initialReplayState(initial), initial.seed, 10000).replay;
await writeFile(
  new URL('./fixtures/monthly-golden.json', import.meta.url),
  await serialize({ stateHash: hashState(replay), replay }),
);
