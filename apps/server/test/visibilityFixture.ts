import { readFile } from 'node:fs/promises';
import type { WorldInit } from '@opensamguk/rules';

export async function visibilityFixture(): Promise<WorldInit> {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/visibility-initial.json', import.meta.url), 'utf8'),
  ) as { initial: WorldInit };
  return fixture.initial;
}
