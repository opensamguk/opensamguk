import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import manifest from '../../resources/portraits/191-supplement.json';

const directory = new URL('../../private/portraits-supplement/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const row of manifest.portraits) {
  const file = new URL(row.filename, directory);
  const valid = (bytes: Uint8Array) =>
    bytes.length === row.bytes && createHash('sha256').update(bytes).digest('hex') === row.sha256;
  let existing: Buffer | undefined;
  try {
    existing = await readFile(file);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (existing) {
    if (!valid(existing)) throw new Error(`${row.name}: 기존 파일의 내용 해시가 다릅니다. 덮어쓰지 않았습니다.`);
  } else {
    const response = await fetch(row.sourceImage, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${row.name}: 초상 HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!valid(bytes)) throw new Error(`${row.name}: 받은 원본의 내용 해시가 다릅니다.`);
    await writeFile(file, bytes, { flag: 'wx' });
  }
  console.log(`${row.name}: 개발용 원본 ${row.id} 내용 해시 확인`);
}
