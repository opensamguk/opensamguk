import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import provenance from './icons/sources.json';
it('reuses the pinned 32px exports without altering pixel bytes', () => {
  expect(provenance.assets.map((a) => a.kind)).toEqual(['city', 'pass', 'port', 'field']);
  for (const asset of provenance.assets) {
    const bytes = readFileSync(new URL(`./icons/${asset.kind}.png`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(32);
    expect(bytes.readUInt32BE(20)).toBe(32);
  }
});
